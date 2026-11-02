// api/_feed-woo.js
// ─────────────────────────────────────────────────────────────────────────────
// WooCommerce source adapter for the Bulk Feed ingest router (feed-ingest.js).
//
// WooCommerce has no universal public /products.json like Shopify, but modern Woo
// exposes a PUBLIC, no-auth Store API at /wp-json/wc/store/v1/products. That gives
// Woo stores the same "enter a URL" magic. This helper probes + ingests it and
// returns the SAME canonical record feed-ingest emits, so the UI needs no changes.
//
// Underscore-prefixed → Vercel does not treat it as an endpoint (it is imported).
// Self-contained (its own small normalizers) so it stays fully isolated.
//
// Store API product fields used (confirmed against the Store API ProductSchema):
//   id, name, description, short_description, permalink, images[].src,
//   prices{ price, regular_price, sale_price, currency_code, currency_minor_unit },
//   on_sale, is_in_stock, categories[].name
// Prices are integer strings in the currency's MINOR units (currency_minor_unit decimals).
// ─────────────────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (compatible; AIAdStudioFeedBot/1.0; +https://theaiad.studio)';
// Versioned path first (current Woo); bare path is the older alias.
const WOO_PATHS = ['/wp-json/wc/store/v1/products', '/wp-json/wc/store/products'];

async function tryFetchJson(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

// Probe: is this origin a WooCommerce store exposing the public Store API?
// Returns the working products path (truthy) or null.
export async function probeWoo(origin) {
  for (const p of WOO_PATHS) {
    const data = await tryFetchJson(origin + p + '?per_page=1');
    if (Array.isArray(data)) return p;
  }
  return null;
}

export async function ingestWoo(origin, max) {
  const base = (await probeWoo(origin)) || WOO_PATHS[0];
  const products = [];
  for (let page = 1; page <= 40 && products.length < max; page++) {
    const data = await tryFetchJson(origin + base + '?per_page=100&page=' + page);
    const batch = Array.isArray(data) ? data : [];
    if (!batch.length) break;
    for (const p of batch) {
      products.push(normalizeWoo(p, origin));
      if (products.length >= max) break;
    }
    if (batch.length < 100) break;
  }
  if (!products.length) {
    throw new Error("No products found via the WooCommerce Store API (the store may have it disabled). " +
                    "Paste the store's Google Merchant / GMC feed URL instead.");
  }
  return { source: 'woocommerce', feedUrl: origin + base, count: products.length, products };
}

// Store API prices are integer strings in minor units: "1999" @ minor 2 → "19.99".
function wooPrice(prices, key) {
  if (!prices) return null;
  const raw = prices[key];
  if (raw == null || raw === '') return null;
  const minor = Number.isFinite(prices.currency_minor_unit) ? prices.currency_minor_unit : 2;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return null;
  return (n / Math.pow(10, minor)).toFixed(minor);
}

function normalizeWoo(p, origin) {
  const images = (Array.isArray(p.images) ? p.images : [])
    .map(im => im && im.src).filter(Boolean).map(toHttps);
  const prices = p.prices || {};
  const price = wooPrice(prices, 'price');          // current price (sale-aware)
  const reg = wooPrice(prices, 'regular_price');
  const onSale = !!p.on_sale;
  const cats = Array.isArray(p.categories) ? p.categories : [];
  const rec = {
    id: String(p.id || ''),
    title: (p.name || '').trim(),
    description: htmlToText(p.description || p.short_description || ''),
    link: p.permalink || origin,
    images,
    image: images[0] || null,
    price,
    currency: prices.currency_code || null,
    onSale,
    regularPrice: (onSale && reg && reg !== price) ? reg : null,
    availability: p.is_in_stock === false ? 'out_of_stock' : 'in_stock',
    brand: null,                                      // Woo has no native brand field
    productType: (cats[0] && cats[0].name) || null,
    gtin: null,
    locale: null,
  };
  rec.fields = coverage(rec);
  return rec;
}

// ── self-contained helpers (mirror feed-ingest.js) ──────────────────────────
function toHttps(u) {
  if (!u) return u;
  if (u.startsWith('//')) return 'https:' + u;
  return u.replace(/^http:\/\//i, 'https://');
}
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#x0*26;/gi, '&').replace(/&#0*38;/g, '&');
}
function htmlToText(html) {
  if (!html) return '';
  let t = String(html).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  t = t.replace(/<\s*br\s*\/?>/gi, ' ').replace(/<\/(p|div|li|h[1-6])>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t).replace(/\s+/g, ' ').trim();
  return t.slice(0, 600);
}
function coverage(rec) {
  return {
    title: !!rec.title, description: !!rec.description, image: !!rec.image,
    price: !!rec.price, brand: !!rec.brand, gtin: !!rec.gtin,
  };
}

// Named exports for offline parser tests (Vercel never invokes this file as a route).
export { normalizeWoo, wooPrice };
