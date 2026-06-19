/**
 * /api/scrape-logo — find the best brand logo on a page, in priority order.
 *
 * Deliberately separate from /api/scrape, which deprioritizes logos while hunting
 * product images. This one does the opposite: it hunts the brand logo specifically.
 *
 * Priority (best → worst):
 *   1. JSON-LD Organization/publisher logo  (brand-declared, usually the real mark)
 *   2. Web app manifest icons               (often 192/512px — highest res)
 *   3. apple-touch-icon                      (usually 180px+, square)
 *   4. og:logo / og:image                    (sometimes a logo)
 *   5. header/nav <img> with "logo"          (the visible site logo)
 *   6. high-res rel=icon (sizes >= 64)       (better than a 16px favicon)
 *
 * Returns: { best, candidates: [{ url, source, size }] } — absolute URLs, deduped,
 * in priority order. Empty candidates → caller falls back to the favicon (Tier 3).
 */

function absolutize(href, base) {
  try { return new URL(href, base).href; } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const pageRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!pageRes.ok) return res.status(422).json({ error: `Could not fetch page (HTTP ${pageRes.status})` });
    const html = await pageRes.text();
    const base = pageRes.url || url; // final URL after redirects, for relative-path resolution

    const candidates = [];
    const push = (href, source, size) => {
      if (!href) return;
      const abs = absolutize(href, base);
      if (abs && !candidates.some(c => c.url === abs)) candidates.push({ url: abs, source, size: size || null });
    };
    const sizePx = (s) => parseInt((s || '0').split(/x|×/i)[0], 10) || 0;

    // 1. JSON-LD Organization / publisher logo
    for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const json = JSON.parse(m[1].trim());
        const roots = Array.isArray(json) ? json : (json['@graph'] || [json]);
        for (const node of (Array.isArray(roots) ? roots : [roots])) {
          const logo = node?.logo;
          if (typeof logo === 'string') push(logo, 'jsonld');
          else if (logo?.url) push(logo.url, 'jsonld');
          const pub = node?.publisher?.logo;
          if (typeof pub === 'string') push(pub, 'jsonld');
          else if (pub?.url) push(pub.url, 'jsonld');
        }
      } catch { /* malformed JSON-LD block — skip */ }
    }

    // 2. Web app manifest icons (largest first)
    const manifestHref =
      html.match(/<link[^>]+rel=["']manifest["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
      html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']manifest["']/i)?.[1];
    if (manifestHref) {
      const manifestUrl = absolutize(manifestHref, base);
      if (manifestUrl) {
        try {
          const mRes = await fetch(manifestUrl);
          if (mRes.ok) {
            const manifest = await mRes.json();
            const icons = (manifest.icons || []).slice().sort((a, b) => sizePx(b.sizes) - sizePx(a.sizes));
            for (const ic of icons) push(ic.src, 'manifest', ic.sizes);
          }
        } catch { /* manifest fetch/parse failed — skip */ }
      }
    }

    // 3. apple-touch-icon(s)
    for (const m of html.matchAll(/<link[^>]+rel=["'][^"']*apple-touch-icon[^"']*["'][^>]*>/gi)) {
      const tag = m[0];
      push(tag.match(/href=["']([^"']+)["']/i)?.[1], 'apple-touch-icon', tag.match(/sizes=["']([^"']+)["']/i)?.[1]);
    }

    // 4. og:logo, then og:image
    push(html.match(/<meta[^>]+property=["']og:logo["'][^>]+content=["']([^"']+)["']/i)?.[1], 'og:logo');
    push(
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1],
      'og:image'
    );

    // 5. header/nav <img> whose tag mentions "logo"
    const headerZone =
      (html.match(/<header[\s\S]*?<\/header>/i)?.[0] || '') +
      (html.match(/<nav[\s\S]*?<\/nav>/i)?.[0] || '');
    for (const m of (headerZone || html).matchAll(/<img[^>]+>/gi)) {
      const tag = m[0];
      if (/logo/i.test(tag)) push(tag.match(/(?:data-src|src)=["']([^"']+)["']/i)?.[1], 'header-img');
    }

    // 6. high-res rel=icon (>= 64px; skips tiny 16/32 favicons and apple-touch handled above)
    for (const m of html.matchAll(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*>/gi)) {
      const tag = m[0];
      if (/apple-touch/i.test(tag)) continue;
      const size = tag.match(/sizes=["']([^"']+)["']/i)?.[1];
      if (sizePx(size) >= 64) push(tag.match(/href=["']([^"']+)["']/i)?.[1], 'rel-icon', size);
    }

    return res.status(200).json({ best: candidates[0]?.url || null, candidates });
  } catch (err) {
    return res.status(500).json({ error: 'Logo scrape failed', detail: String(err?.message || err) });
  }
}
