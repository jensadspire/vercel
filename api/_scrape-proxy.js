/**
 * api/_scrape-proxy.js — backup fetch route for sites that block Vercel's server IP.
 *
 * The underscore prefix means Vercel does NOT expose this as a public route (same
 * convention as _ai-label.js / _brand-extract.js) — it's imported by scrape.js only.
 *
 * Some sites (bot-protected or datacenter-IP-blocked e-comm, e.g. athlecia, SkinCeuticals)
 * return a block/challenge page or nothing to a plain server-side fetch from Vercel,
 * even though a normal browser loads them fine. This fetches the target URL's HTML
 * through a scraping/unblocker proxy (residential/rotating IPs, challenge solving),
 * so those sites resolve to their real HTML — which scrape.js then parses as usual.
 *
 * Provider-agnostic. Configure ONE env var, SCRAPE_PROXY_TEMPLATE, as a full URL with
 * a {url} placeholder and your key baked in. Examples:
 *   ScraperAPI:   https://api.scraperapi.com/?api_key=YOUR_KEY&url={url}
 *   ScrapingBee:  https://app.scrapingbee.com/api/v1/?api_key=YOUR_KEY&url={url}&render_js=false
 *
 * FAIL-OPEN: returns null if unconfigured or on any error, so scrape.js behaves
 * exactly as before whenever no proxy is set (safe to deploy with the var unset).
 *
 * @param {string} url - the target page URL to fetch via the proxy.
 * @returns {Promise<string|null>} the page HTML, or null on any failure / if unconfigured.
 */
export async function fetchViaProxy(url) {
  const template = process.env.SCRAPE_PROXY_TEMPLATE;
  if (!template || !template.includes('{url}')) return null; // unconfigured → no-op
  try {
    const proxied = template.replace('{url}', encodeURIComponent(url));
    const res = await fetch(proxied, {
      // The proxy fetches + (optionally) renders + solves challenges server-side,
      // so give it much more headroom than the direct 8s fetch.
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      console.log('[scrape-proxy] proxy returned', res.status, 'for', url);
      return null;
    }
    const html = await res.text();
    return (html && html.length > 200) ? html : null;
  } catch (e) {
    console.log('[scrape-proxy] error (fail-open):', e.message);
    return null;
  }
}
