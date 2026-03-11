/**
 * /api/sitemap — Domain URL Scanner
 * Ported from Google Apps Script v7
 * Strategies (in order):
 *   1. robots.txt  — reads Sitemap: directives
 *   2. 20 known sitemap paths
 *   3. Homepage HTML nav crawl
 *
 * Returns:
 *   { categories: [{ name, slug, urls: [...], count }], method, total }
 *   OR { error, diagnosis }
 */

// ── Config ────────────────────────────────────────────────────────────────────
const MAX_URLS       = 200;   // max URLs to collect before slicing
const MAX_PER_CAT    = 50;    // max URLs per category returned
const FETCH_TIMEOUT  = 8000;  // ms per fetch

const SITEMAP_PATHS = [
  "/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml",
  "/sitemaps/sitemap.xml", "/sitemap/sitemap.xml",
  "/sitemap_products.xml", "/sitemap_product.xml", "/sitemap-products.xml",
  "/sitemap_categories.xml", "/sitemap_category.xml", "/sitemap-categories.xml",
  "/sitemap_collections.xml", "/sitemap_pages.xml",
  "/sitemap1.xml", "/sitemap2.xml",
  "/wp-sitemap.xml", "/page-sitemap.xml", "/product-sitemap.xml",
  "/category-sitemap.xml", "/post-sitemap.xml",
];

const PRODUCT_KEYWORDS = [
  "/product", "/produkt", "/products", "/produkter",
  "/category", "/kategori", "/categories", "/kategorier",
  "/shop", "/store", "/butik", "/collection", "/kollektion", "/collections",
  "/item", "/vare", "/varer", "/p/", "/c/", "/cat/",
  "/kabler", "/kabel", "/elektronik", "/mobil",
  "/kokken", "/bord", "/bolig", "/gaver",
  "/dame", "/herre", "/barn", "/boern", "/baby",
  "/toej", "/mode", "/jakker", "/bukser", "/kjole",
  "/fodtoej", "/sko", "/stoevler", "/taske", "/tasker", "/smykker",
  "/haar", "/beauty", "/makeup", "/hudpleje", "/parfume",
  "/sport", "/outdoor", "/fritid", "/cykel", "/fitness",
  "/moebel", "/indretning", "/lamper",
  "/have", "/vaerktoej",
  "/clothes", "/shoes", "/equipment", "/toys", "/children", "/outlet",
  "/accessories", "/accessoires", "/kleidung", "/schuhe",
  "/tilbud", "/udsalg", "/nyheder",
];

const EXCLUDE_KEYWORDS = [
  "/faq", "/help", "/support", "/kundeservice",
  "/login", "/account", "/konto", "/profil", "/min-side",
  "/checkout", "/cart", "/kurv", "/kasse",
  "/tag/", "/author/",
  "/cookie", "/privacy", "/gdpr", "/vilkaar", "/handelsbetingelser",
  "/404", "/search", "/soeg",
  "/job", "/karriere", "/career",
  "/kontakt", "/contact", "/about", "/om-os",
  "/blog", "/news", "/nyhed", "/artikel",
  "/newsletter", "/sitemap", "/pages/account",
];

const BINARY_EXT = [
  ".jpg", ".jpeg", ".png", ".gif", ".pdf", ".xml",
  ".css", ".js", ".svg", ".webp", ".ico", ".woff", ".woff2",
];

// ── Fetch helper ──────────────────────────────────────────────────────────────
async function fetchUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en,de;q=0.8,da;q=0.6",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    const code = res.status;
    if (code !== 200) return { code, body: null };
    const body = await res.text();
    return { code, body };
  } catch (e) {
    clearTimeout(timer);
    return { code: 0, body: null, error: e.message };
  }
}

// ── URL utils ─────────────────────────────────────────────────────────────────
function normalizeDomain(input) {
  let d = input.trim().toLowerCase();
  if (!d.startsWith("http://") && !d.startsWith("https://")) d = "https://" + d;
  return d.replace(/\/$/, "");
}

function getDepth(url) {
  try {
    const path = new URL(url).pathname.replace(/\.html?$/, "");
    return path.split("/").filter(Boolean).length;
  } catch { return 0; }
}

function getFirstSegment(url) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean)[0] || "";
  } catch { return ""; }
}

function isExcluded(url) {
  const l = url.toLowerCase();
  if (BINARY_EXT.some(ext => l.endsWith(ext))) return true;
  return EXCLUDE_KEYWORDS.some(k => l.includes(k));
}

function hasProductKeyword(url) {
  const l = url.toLowerCase();
  return PRODUCT_KEYWORDS.some(k => l.includes(k));
}

function isXml(body) {
  return body && (
    body.trimStart().startsWith("<?xml") ||
    body.includes("<urlset") ||
    body.includes("<sitemapindex")
  );
}

function isCloudflare(body) {
  return body && (
    body.includes("cf-browser-verification") ||
    body.includes("challenge-platform") ||
    body.includes("cf_chl_") ||
    body.includes("Just a moment")
  );
}

function extractLocs(xml) {
  return (xml.match(/<loc>(.*?)<\/loc>/g) || [])
    .map(m => m.replace(/<\/?loc>/g, "").trim());
}

function isSitemapIndex(xml) {
  return xml.includes("<sitemapindex") ||
    (xml.includes("<sitemap>") && xml.includes("<loc>"));
}

// ── Strategy 1: robots.txt ────────────────────────────────────────────────────
async function getSitemapsFromRobots(domain) {
  const { body } = await fetchUrl(domain + "/robots.txt");
  if (!body) return [];
  return body.split("\n")
    .map(l => l.trim())
    .filter(l => l.toLowerCase().startsWith("sitemap:"))
    .map(l => l.substring(8).trim())
    .filter(u => u.startsWith("http"));
}

// ── Strategy 2: collect from sitemap XML ─────────────────────────────────────
async function collectFromSitemapXml(xml, sourceUrl, visited = new Set()) {
  const all = [];
  visited.add(sourceUrl);
  if (isSitemapIndex(xml)) {
    const children = extractLocs(xml).filter(u => u.endsWith(".xml"));
    for (const child of children) {
      if (visited.has(child)) continue;
      visited.add(child);
      const { body } = await fetchUrl(child);
      if (!body) continue;
      all.push(...extractLocs(body).filter(u => !u.endsWith(".xml")));
      if (all.length > MAX_URLS) break;
    }
  } else {
    all.push(...extractLocs(xml).filter(u => !u.endsWith(".xml")));
  }
  return all;
}

// ── Strategy 3: homepage nav crawl ───────────────────────────────────────────
function extractNavLinks(html, domain) {
  const domainHost = domain.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const hrefRegex = /href=["']([^"'#?][^"']*?)["']/gi;
  const seen = new Set();
  const candidates = [];
  let m;
  while ((m = hrefRegex.exec(html)) !== null) {
    let href = m[1].trim();
    if (href.startsWith("/")) href = domain + href;
    else if (!href.startsWith("http")) continue;
    const hrefHost = href.replace(/^https?:\/\//, "").replace(/^www\./, "");
    if (!hrefHost.startsWith(domainHost)) continue;
    href = href.split("?")[0].split("#")[0];
    if (isExcluded(href)) continue;
    const depth = getDepth(href);
    if (depth < 1 || depth > 4) continue;
    if (!seen.has(href)) { seen.add(href); candidates.push(href); }
  }
  candidates.sort((a, b) => {
    const aKw = hasProductKeyword(a) ? 1 : 0;
    const bKw = hasProductKeyword(b) ? 1 : 0;
    if (aKw !== bKw) return bKw - aKw;
    return getDepth(a) - getDepth(b);
  });
  return candidates.slice(0, MAX_URLS);
}

// ── Pick best URLs ────────────────────────────────────────────────────────────
function pickAndGroup(allUrls) {
  const filtered = allUrls.filter(u => !isExcluded(u));
  if (!filtered.length) return null;

  // Group by first path segment
  const groups = {};
  for (const url of filtered) {
    const seg = getFirstSegment(url);
    if (!seg) continue;
    if (!groups[seg]) groups[seg] = [];
    groups[seg].push(url);
  }

  // Score each group — prefer keyword matches, good depth, volume
  const scored = Object.entries(groups).map(([slug, urls]) => {
    const kwCount = urls.filter(hasProductKeyword).length;
    const depths = urls.map(getDepth);
    const avgDepth = depths.reduce((a, b) => a + b, 0) / depths.length;
    const score =
      (kwCount / Math.max(urls.length, 1)) * 40 +  // keyword ratio
      Math.min(urls.length / 5, 10) +               // volume bonus
      (avgDepth >= 1 && avgDepth <= 4 ? 10 : 0);    // depth sweet spot
    return { slug, urls, score, kwCount };
  });

  // Sort: keyword-rich groups first, then by score
  scored.sort((a, b) => b.score - a.score);

  // Build category list — top groups with at least 1 URL
  return scored
    .filter(g => g.urls.length >= 1)
    .slice(0, 20)
    .map(g => ({
      slug: g.slug,
      name: g.slug.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      urls: g.urls.slice(0, MAX_PER_CAT),
      count: g.urls.length,
    }));
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { domain: rawDomain } = req.body || {};
  if (!rawDomain) return res.status(400).json({ error: "domain is required" });

  const domain = normalizeDomain(rawDomain);

  // ── Reachability check ────────────────────────────────────────────────────
  const home = await fetchUrl(domain + "/");
  if (home.code === 0)   return res.json({ error: "Domain unreachable", diagnosis: "DNS or connection error — check the URL and try again" });
  if (home.code === 403) return res.json({ error: "Access blocked", diagnosis: "Server is blocking automated requests (403)" });
  if (home.code === 429) return res.json({ error: "Rate limited", diagnosis: "Too many requests — try again in a few seconds" });
  if (home.code >= 500)  return res.json({ error: "Server error", diagnosis: `Site returned ${home.code} — may be temporarily down` });
  if (home.body && isCloudflare(home.body)) {
    return res.json({ error: "Cloudflare protected", diagnosis: "This site uses Cloudflare bot protection — use the Apps Script method instead", fallback: true });
  }

  let allUrls = [];
  let method = "";

  // ── Strategy 1: robots.txt sitemaps ──────────────────────────────────────
  const robotsSitemaps = await getSitemapsFromRobots(domain);
  if (robotsSitemaps.length > 0) {
    for (const sitemapUrl of robotsSitemaps) {
      const { body } = await fetchUrl(sitemapUrl);
      if (!body || !isXml(body)) continue;
      const urls = await collectFromSitemapXml(body, sitemapUrl);
      allUrls.push(...urls);
      if (allUrls.length >= MAX_URLS) break;
    }
    if (allUrls.length > 0) method = "robots.txt sitemap";
  }

  // ── Strategy 2: known sitemap paths ──────────────────────────────────────
  if (allUrls.length === 0) {
    for (const path of SITEMAP_PATHS) {
      const { body, code } = await fetchUrl(domain + path);
      if (!body || !isXml(body) || code === 403) continue;
      const urls = await collectFromSitemapXml(body, domain + path);
      allUrls.push(...urls);
      if (allUrls.length > 0) { method = "sitemap XML"; break; }
    }
  }

  // ── Strategy 3: homepage nav crawl ───────────────────────────────────────
  if (allUrls.length === 0 && home.body) {
    allUrls = extractNavLinks(home.body, domain);
    if (allUrls.length > 0) method = "homepage navigation";
  }

  if (allUrls.length === 0) {
    return res.json({
      error: "No URLs found",
      diagnosis: "Could not find a sitemap or extract navigation links. Try the Apps Script method for JS-rendered sites.",
      fallback: true,
    });
  }

  // ── Group and return ──────────────────────────────────────────────────────
  const categories = pickAndGroup(allUrls);
  if (!categories || categories.length === 0) {
    return res.json({ error: "No product categories detected", diagnosis: "Found URLs but could not identify product/category structure", fallback: true });
  }

  return res.json({
    categories,
    method,
    total: allUrls.length,
    domain,
  });
}
