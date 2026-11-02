// api/_feed-wix.js
// ─────────────────────────────────────────────────────────────────────────────
// Wix Stores source adapter for the Bulk Feed ingest router (feed-ingest.js).
//
// Wix has no public catalog API, but Wix Thunderbolt SERVER-RENDERS the product
// grid into the page HTML as a JSON blob under catalog.category.productsWithMetaData.
// So we fetch the store/gallery page HTML (already done by the router) and parse the
// embedded products — no auth token, no GraphQL. Same canonical record as the others.
//
// Underscore-prefixed → Vercel does not treat it as an endpoint (it is imported).
// Self-contained. Catalog V3 shape confirmed from a live store (aksglaede.com).
//
// Embedded product fields: id, name, price, comparePrice, formattedPrice, currency,
//   sku, isInStock, urlPart (→ /product-page/<urlPart>), media[].fullUrl, ribbon.
// Note: the grid blob is one page per gallery/category (a sample, ~20–100 products),
//   and carries no long description. Enough to drive ad generation; full pagination
//   would need the token+GraphQL path and can be added later.
// ─────────────────────────────────────────────────────────────────────────────

// True when a fetched page embeds a Wix product grid.
export function isWixProductPage(html) {
  return typeof html === 'string' && html.includes('"productsWithMetaData"');
}

// Parse the embedded grid(s) from page HTML → canonical products.
export function ingestWix(pageUrl, html, max) {
  let origin = pageUrl;
  try { origin = new URL(pageUrl).origin; } catch (_) {}

  const blocks = extractGalleries(html);           // [{ category, list }]
  const seen = new Set();
  const products = [];
  for (const b of blocks) {
    for (const p of b.list) {
      const id = String(p && p.id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      products.push(normalizeWix(p, origin, b.category));
      if (products.length >= max) break;
    }
    if (products.length >= max) break;
  }
  if (!products.length) {
    throw new Error("Found a Wix store but no products embedded on this page. Paste the store's product/shop " +
                    "page URL (the page that shows your product grid), or the store's Google Merchant feed URL.");
  }
  return { source: 'wix', feedUrl: pageUrl, count: products.length, products, language: wixLanguage(html) };
}

// ── embedded-JSON extraction ─────────────────────────────────────────────────
function extractGalleries(html) {
  const out = [];
  const marker = '"productsWithMetaData":';
  let idx = 0;
  while (true) {
    const m = html.indexOf(marker, idx);
    if (m === -1) break;
    idx = m + marker.length;
    const listKey = html.indexOf('"list":', m);
    if (listKey === -1) continue;
    const br = html.indexOf('[', listKey);
    if (br === -1) continue;
    const raw = readBalanced(html, br);
    if (!raw) continue;
    let list;
    try { list = JSON.parse(raw); } catch (_) { continue; }
    if (!Array.isArray(list) || !list.length) continue;
    out.push({ category: nearestCategoryName(html, m), list });
  }
  return out;
}

// Balanced [...] / {...} reader that respects JSON strings & escapes.
function readBalanced(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

// The category name sits just before productsWithMetaData: ..."name":"Sko","visible":true,"productsWithMetaData"...
function nearestCategoryName(html, atIndex) {
  const pre = html.slice(Math.max(0, atIndex - 400), atIndex);
  const all = pre.match(/"name":"((?:[^"\\]|\\.)*)"/g);
  if (!all || !all.length) return null;
  const last = all[all.length - 1].match(/"name":"((?:[^"\\]|\\.)*)"/);
  return last ? jsonUnescape(last[1]) : null;
}

function normalizeWix(p, origin, categoryName) {
  const media = Array.isArray(p.media) ? p.media : [];
  const images = media.map(m => m && (m.fullUrl || m.url)).filter(Boolean)
    .filter(u => /^https?:\/\//i.test(u) || u.startsWith('//')).map(toHttps);
  const price = (p.price != null) ? String(p.price) : null;
  const comp = (typeof p.comparePrice === 'number') ? p.comparePrice : 0;
  const onSale = !!(comp && p.price != null && comp > Number(p.price));
  const rec = {
    id: String(p.id || ''),
    title: (p.name || '').trim(),
    description: '',                                 // not in the grid blob
    link: p.urlPart ? (origin + '/product-page/' + p.urlPart) : origin,
    images,
    image: images[0] || null,
    price,
    currency: p.currency || null,
    onSale,
    regularPrice: onSale ? String(comp) : null,
    availability: (p.isInStock === false || (p.inventory && p.inventory.status === 'out_of_stock')) ? 'out_of_stock' : 'in_stock',
    brand: null,
    productType: categoryName || null,
    gtin: null,
    locale: null,
  };
  rec.fields = coverage(rec);
  return rec;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function wixLanguage(html) {
  const LANG = { en: 'English', da: 'Danish', de: 'German', sv: 'Swedish', nb: 'Norwegian', nn: 'Norwegian', no: 'Norwegian', fi: 'Finnish', nl: 'Dutch', fr: 'French', it: 'Italian', es: 'Spanish', pt: 'Portuguese', pl: 'Polish', cs: 'Czech', ro: 'Romanian', el: 'Greek', tr: 'Turkish', ru: 'Russian', uk: 'Ukrainian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese' };
  const m = String(html).match(/<html[^>]*\blang=["']([a-z]{2})(?:-[a-z]{2})?["']/i);
  return (m && LANG[m[1].toLowerCase()]) || null;
}
function toHttps(u) {
  if (!u) return u;
  if (u.startsWith('//')) return 'https:' + u;
  return u.replace(/^http:\/\//i, 'https://');
}
function jsonUnescape(s) {
  try { return JSON.parse('"' + String(s).replace(/"/g, '\\"') + '"'); } catch (_) { return s; }
}
function coverage(rec) {
  return {
    title: !!rec.title, description: !!rec.description, image: !!rec.image,
    price: !!rec.price, brand: !!rec.brand, gtin: !!rec.gtin,
  };
}

export { normalizeWix };
