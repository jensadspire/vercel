// ── scrape-youtube.js ─────────────────────────────────────────────────────────
// Scrape-ONLY YouTube discovery. Given a URL, fetches the page HTML and extracts
// any YouTube channel or video references the brand has linked on their own site:
//   • footer/header anchor links to youtube.com/@handle, /channel/, /c/, /user/
//   • og:video / og:video:url meta tags
//   • JSON-LD Organization.sameAs[] arrays listing a YouTube channel
//   • embedded youtube.com/embed/<id> and youtu.be/<id> URLs
//
// IMPORTANT: this endpoint makes NO call to the YouTube Data API. It only parses
// HTML the site already serves. This keeps the feature free of any new OAuth scope
// (no youtube.* scope), so it never affects Google Ads OAuth verification.
//
// Returns suggestions only — the UI frames these as "found on your site, copy to
// paste into Google Ads", NOT as auto-attachable assets (PMax only accepts videos
// hosted on the advertiser's OWN linked channel, which we cannot guarantee here).

async function redis(command, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/${[command, ...args].map(encodeURIComponent).join("/")}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data.result;
  } catch (_) { return null; }
}

const CACHE_TTL = 60 * 60 * 24; // 24 hours

// Normalize a raw YouTube URL/handle into a clean canonical form + classify it.
function classifyYouTube(raw) {
  if (!raw) return null;
  let u = raw.trim();
  // strip leading protocol-relative or whitespace
  if (u.startsWith("//")) u = "https:" + u;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u.replace(/^\/+/, "");
  let parsed;
  try { parsed = new URL(u); } catch (_) { return null; }
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "youtu.be") return null;

  // youtu.be/<id> → a specific video
  if (host === "youtu.be") {
    const id = parsed.pathname.replace(/^\/+/, "").split("/")[0];
    if (id) return { type: "video", url: `https://www.youtube.com/watch?v=${id}`, id };
    return null;
  }
  const path = parsed.pathname;
  // /watch?v=<id> → specific video
  if (path === "/watch") {
    const id = parsed.searchParams.get("v");
    if (id) return { type: "video", url: `https://www.youtube.com/watch?v=${id}`, id };
  }
  // /embed/<id> → specific video
  let m = path.match(/^\/embed\/([A-Za-z0-9_-]{6,})/);
  if (m) return { type: "video", url: `https://www.youtube.com/watch?v=${m[1]}`, id: m[1] };
  // /@handle → channel
  m = path.match(/^\/(@[A-Za-z0-9._-]+)/);
  if (m) return { type: "channel", url: `https://www.youtube.com/${m[1]}`, handle: m[1] };
  // /channel/<id>, /c/<name>, /user/<name> → channel
  m = path.match(/^\/(channel|c|user)\/([A-Za-z0-9._-]+)/);
  if (m) return { type: "channel", url: `https://www.youtube.com/${m[1]}/${m[2]}` };
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "URL is required" });

  const cacheKey = `rsa:ytscan:${url.toLowerCase().replace(/\/$/, "")}`;
  try {
    const cached = await redis("GET", cacheKey);
    if (cached) return res.status(200).json({ ...JSON.parse(cached), cached: true });
  } catch (_) { /* continue to live scrape */ }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      signal: AbortSignal.timeout(8000),
    });
    const html = await response.text();

    const channels = new Map(); // url → {type, url, handle?}
    const videos = new Map();   // url → {type, url, id}
    const addHit = (raw) => {
      const c = classifyYouTube(raw);
      if (!c) return;
      if (c.type === "channel" && !channels.has(c.url)) channels.set(c.url, c);
      if (c.type === "video" && !videos.has(c.url)) videos.set(c.url, c);
    };

    // 1. All anchor hrefs pointing at youtube
    const hrefRe = /href\s*=\s*["']([^"']*(?:youtube\.com|youtu\.be)[^"']*)["']/gi;
    let m;
    while ((m = hrefRe.exec(html)) !== null) addHit(m[1]);

    // 2. og:video / og:video:url meta tags
    const ogRe = /<meta[^>]+(?:property|name)\s*=\s*["']og:video(?::url|:secure_url)?["'][^>]+content\s*=\s*["']([^"']+)["']/gi;
    while ((m = ogRe.exec(html)) !== null) addHit(m[1]);

    // 3. iframe src (embedded players)
    const iframeRe = /<iframe[^>]+src\s*=\s*["']([^"']*(?:youtube\.com|youtu\.be)[^"']*)["']/gi;
    while ((m = iframeRe.exec(html)) !== null) addHit(m[1]);

    // 4. JSON-LD Organization.sameAs — look for youtube urls inside any ld+json block
    const ldRe = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    while ((m = ldRe.exec(html)) !== null) {
      try {
        const json = JSON.parse(m[1].trim());
        const scan = (node) => {
          if (!node) return;
          if (Array.isArray(node)) return node.forEach(scan);
          if (typeof node === "object") {
            if (Array.isArray(node.sameAs)) node.sameAs.forEach(s => { if (/youtube\.com|youtu\.be/i.test(s)) addHit(s); });
            Object.values(node).forEach(scan);
          }
        };
        scan(json);
      } catch (_) { /* malformed ld+json — skip */ }
    }

    const result = {
      channels: Array.from(channels.values()),
      videos: Array.from(videos.values()),
      // The advertiser must confirm ownership — these are suggestions only.
      note: "Discovered on the site. Confirm the channel is yours before using videos in Google Ads.",
    };

    try { await redis("SET", cacheKey, JSON.stringify(result), "EX", String(CACHE_TTL)); } catch (_) {}
    return res.status(200).json(result);
  } catch (err) {
    return res.status(200).json({ channels: [], videos: [], error: err.message || "scan failed" });
  }
}
