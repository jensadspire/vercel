// api/feed-ingest.js
// ─────────────────────────────────────────────────────────────────────────────
// Bulk Feed module — Phase 1: product-catalog ingestion (standalone, additive).
//
// Parses either a Google Merchant Center (GMC) product feed — RSS 2.0 / Atom XML
// or TSV — OR a Shopify public /products.json, and returns a NORMALIZED product
// list in one canonical shape the ad engine can consume. No existing code touched.
//
// Phase-1 wiring (A): each normalized product's `link` is handed to the existing
// URL→ad pipeline. The normalized record already carries images + copy, so the
// Phase-2 (B) scrape-bypass (generateFromProduct) is a drop-in later — no reshape.
//
// Canonical record:
//   { id, title, description, link, images[], image, price, currency,
//     availability, brand, productType, gtin, locale, fields{} }
//   `fields` = per-field coverage flags → powers the "attributes used" column.
// ─────────────────────────────────────────────────────────────────────────────

const UA = 'Mozilla/5.0 (compatible; AIAdStudioFeedBot/1.0; +https://theaiad.studio)';

// ── Feed-language detection ──────────────────────────────────────────────────
// ISO-639-1 → English language name (the string the generators inject via "Write in ${language}").
const LANG_NAMES = {
  en: 'English', de: 'German', da: 'Danish', sv: 'Swedish', nb: 'Norwegian', nn: 'Norwegian',
  no: 'Norwegian', fi: 'Finnish', nl: 'Dutch', fr: 'French', it: 'Italian', es: 'Spanish',
  pt: 'Portuguese', pl: 'Polish', cs: 'Czech', sk: 'Slovak', hu: 'Hungarian', ro: 'Romanian',
  el: 'Greek', tr: 'Turkish', ru: 'Russian', uk: 'Ukrainian', ja: 'Japanese', ko: 'Korean',
  zh: 'Chinese', ar: 'Arabic', he: 'Hebrew', is: 'Icelandic', et: 'Estonian', lv: 'Latvian',
  lt: 'Lithuanian', sl: 'Slovenian', hr: 'Croatian', bg: 'Bulgarian', ca: 'Catalan',
};

// Returns an English language NAME (e.g. "German") or null. null → caller defaults to English.
function detectFeedLanguage(source, mode) {
  // 1) Locale in the feed URL (works for BOTH Shopify and GMC — keyed off what the user typed).
  try {
    const u = new URL(/^https?:\/\//i.test(source) ? source : 'https://' + source);
    const path = u.pathname.toLowerCase();
    let m = path.match(/\/([a-z]{2})-[a-z]{2}(?:\/|$)/);   // /ll-cc/  (e.g. /de-de, /da-dk)
    if (!m) m = path.match(/^\/([a-z]{2})(?:\/|$)/);        // leading /ll/  (e.g. /de/...)
    if (m && LANG_NAMES[m[1]]) return LANG_NAMES[m[1]];
  } catch (_) { /* ignore */ }
  // 2) GMC XML bonus: RSS <language> channel tag.
  if (mode && mode.type === 'gmc-xml' && mode.body) {
    const lm = String(mode.body).match(/<language>\s*([a-z]{2})(?:-[a-z]{2})?\s*<\/language>/i);
    if (lm && LANG_NAMES[lm[1].toLowerCase()]) return LANG_NAMES[lm[1].toLowerCase()];
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { source, limit } = req.body || {};
  if (!source || !String(source).trim()) {
    return res.status(400).json({ error: "A feed URL or Shopify store URL is required" });
  }
  const MAX = Math.min(Math.max(parseInt(limit, 10) || 250, 1), 1000);

  try {
    const mode = await detectMode(String(source).trim());
    let result;
    if (mode.type === 'shopify')      result = await ingestShopify(mode.origin, MAX);
    else if (mode.type === 'gmc-xml') result = ingestGmcXml(mode.url, mode.body, MAX);
    else if (mode.type === 'gmc-tsv') result = ingestGmcTsv(mode.url, mode.body, MAX);
    else return res.status(422).json({
      error: "Couldn't recognise this as a Shopify store or a Google Merchant feed. " +
             "Paste a product feed URL (.xml / .tsv) or a Shopify store URL."
    });

    const language = detectFeedLanguage(String(source).trim(), mode);
    console.log('Feed ingest:', mode.type, '| products:', result.count, '| language:', language || 'English (default)');
    return res.status(200).json({ ok: true, language, ...result });
  } catch (err) {
    console.log('Feed ingest error:', err && err.message);
    return res.status(200).json({ ok: false, error: (err && err.message) || "Feed ingestion failed" });
  }
}

// ── Source detection ─────────────────────────────────────────────────────────
async function detectMode(source) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(source) ? source : 'https://' + source); }
  catch (_) { throw new Error("That doesn't look like a valid URL."); }

  const path = u.pathname.toLowerCase();

  // Explicit Shopify
  if (path.includes('/products.json') || /\.myshopify\.com$/i.test(u.hostname)) {
    return { type: 'shopify', origin: u.origin };
  }
  // Explicit feed file by extension
  if (/\.(xml|rss|atom)$/i.test(path)) return { type: 'gmc-xml', url: u.href, body: await fetchText(u.href) };
  if (/\.(tsv|csv|txt)$/i.test(path)) return { type: 'gmc-tsv', url: u.href, body: await fetchText(u.href) };

  // Bare domain → try Shopify /products.json first (cheap, extremely common)
  if (path === '/' || path === '') {
    const probe = await tryFetchJson(u.origin + '/products.json?limit=1');
    if (probe && Array.isArray(probe.products)) return { type: 'shopify', origin: u.origin };
  }

  // Unknown path → fetch + sniff content
  const body = await fetchText(u.href);
  const head = body.slice(0, 2000).toLowerCase();
  if (head.includes('<rss') || head.includes('<feed') || head.includes('<?xml')) {
    return { type: 'gmc-xml', url: u.href, body };
  }
  if (head.includes('\t') && /(^|\t)(id|title|link)(\t|$)/m.test(head)) {
    return { type: 'gmc-tsv', url: u.href, body };
  }
  // Last resort — maybe a Shopify store given with a path
  const probe = await tryFetchJson(u.origin + '/products.json?limit=1');
  if (probe && Array.isArray(probe.products)) return { type: 'shopify', origin: u.origin };

  return { type: 'unknown' };
}

// ── Shopify /products.json ───────────────────────────────────────────────────
async function ingestShopify(origin, max) {
  const products = [];
  for (let page = 1; page <= 40 && products.length < max; page++) {
    const data = await tryFetchJson(origin + '/products.json?limit=250&page=' + page);
    const batch = data && Array.isArray(data.products) ? data.products : [];
    if (!batch.length) break;
    for (const p of batch) {
      products.push(normalizeShopify(p, origin));
      if (products.length >= max) break;
    }
    if (batch.length < 250) break;
  }
  if (!products.length) {
    throw new Error("No public product feed found on this Shopify store (the storefront may have " +
                    "/products.json disabled). Paste the store's Google Merchant / GMC feed URL instead.");
  }
  return { source: 'shopify', feedUrl: origin + '/products.json', count: products.length, products };
}

function normalizeShopify(p, origin) {
  const images = (Array.isArray(p.images) ? p.images : [])
    .map(im => im && im.src).filter(Boolean).map(toHttps);
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const v0 = variants[0] || {};
  const price = v0.price != null ? String(v0.price) : null;
  const compareRaw = v0.compare_at_price;
  const onSale = !!(compareRaw != null && String(compareRaw) !== '' && toNum(compareRaw) > toNum(price));
  const regularPrice = onSale ? String(compareRaw) : null;
  const availability = canonAvail(variants.some(v => v && v.available) ? 'in stock' : 'out of stock');
  const gtin = variants.map(v => v && v.barcode).find(Boolean) || null;
  const rec = {
    id: String(p.id || p.handle || ''),
    title: (p.title || '').trim(),
    description: htmlToText(p.body_html || ''),
    link: p.handle ? (origin + '/products/' + p.handle) : origin,
    images,
    image: images[0] || null,
    price,
    currency: null, // /products.json doesn't expose shop currency unauthenticated
    onSale,
    regularPrice,
    availability,
    brand: (p.vendor || '').trim() || null,
    productType: (p.product_type || '').trim() || null,
    gtin,
    locale: null,
  };
  rec.fields = coverage(rec);
  return rec;
}

// ── GMC XML (RSS <item> / Atom <entry>) ──────────────────────────────────────
function ingestGmcXml(feedUrl, xml, max) {
  let blocks = matchBlocks(xml, 'item');
  if (!blocks.length) blocks = matchBlocks(xml, 'entry');
  const products = [];
  for (const b of blocks) {
    const rec = normalizeGmcBlock(b);
    if (rec.title || rec.link || rec.image) products.push(rec);
    if (products.length >= max) break;
  }
  if (!products.length) throw new Error("No products found (expected RSS <item> or Atom <entry> elements with g: fields).");
  return { source: 'gmc', feedUrl, count: products.length, products };
}

function normalizeGmcBlock(block) {
  const get = fieldGetter(block);
  const image = get('image_link');
  const images = [image, ...fieldGetterAll(block, 'additional_image_link')].filter(Boolean).map(toHttps);
  const reg = splitPrice(get('price'));
  const sale = splitPrice(get('sale_price'));
  const onSale = !!(sale.price != null && reg.price != null && toNum(sale.price) < toNum(reg.price));
  const price = onSale ? sale.price : reg.price;
  const currency = reg.currency || sale.currency || null;
  const regularPrice = onSale ? reg.price : null;
  const rec = {
    id: get('id'),
    title: get('title'),
    description: htmlToText(get('description')),
    link: linkOf(get, block),
    images,
    image: images[0] || null,
    price,
    currency,
    onSale,
    regularPrice,
    availability: canonAvail(get('availability')) || null,
    brand: get('brand') || null,
    productType: get('product_type') || null,
    gtin: get('gtin') || null,
    locale: null,
  };
  rec.fields = coverage(rec);
  return rec;
}

// ── GMC TSV ──────────────────────────────────────────────────────────────────
function ingestGmcTsv(feedUrl, tsv, max) {
  const lines = String(tsv).split(/\r?\n/).filter(l => l.length);
  if (lines.length < 2) throw new Error("TSV feed has no data rows.");
  const header = lines[0].split('\t').map(h => h.trim().toLowerCase().replace(/^g:/, ''));
  const idx = (name) => header.indexOf(name);
  const products = [];
  for (let i = 1; i < lines.length && products.length < max; i++) {
    const cells = lines[i].split('\t');
    const get = (name) => { const j = idx(name); return (j >= 0 && cells[j] != null) ? decodeEntities(cells[j].trim()) : ''; };
    const image = get('image_link');
    const addl = get('additional_image_link');
    const images = [image, ...(addl ? addl.split(',').map(s => s.trim()) : [])].filter(Boolean).map(toHttps);
    const reg = splitPrice(get('price'));
    const sale = splitPrice(get('sale_price'));
    const onSale = !!(sale.price != null && reg.price != null && toNum(sale.price) < toNum(reg.price));
    const price = onSale ? sale.price : reg.price;
    const currency = reg.currency || sale.currency || null;
    const regularPrice = onSale ? reg.price : null;
    const rec = {
      id: get('id'),
      title: get('title'),
      description: htmlToText(get('description')),
      link: get('link'),
      images,
      image: images[0] || null,
      price,
      currency,
      onSale,
      regularPrice,
      availability: canonAvail(get('availability')) || null,
      brand: get('brand') || null,
      productType: get('product_type') || null,
      gtin: get('gtin') || null,
      locale: null,
    };
    if (rec.title || rec.link || rec.image) { rec.fields = coverage(rec); products.push(rec); }
  }
  if (!products.length) throw new Error("No usable rows in TSV feed.");
  return { source: 'gmc', feedUrl, count: products.length, products };
}

// ── Shared helpers ───────────────────────────────────────────────────────────
function matchBlocks(xml, tag) {
  const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'ig');
  const out = []; let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function fieldGetter(block) {
  return (name) => {
    const re = new RegExp('<(?:g:)?' + name + '\\b[^>]*>([\\s\\S]*?)</(?:g:)?' + name + '>', 'i');
    const m = block.match(re);
    return m ? cleanText(m[1]) : '';
  };
}
function fieldGetterAll(block, name) {
  const re = new RegExp('<(?:g:)?' + name + '\\b[^>]*>([\\s\\S]*?)</(?:g:)?' + name + '>', 'ig');
  const out = []; let m;
  while ((m = re.exec(block))) out.push(cleanText(m[1]));
  return out;
}
function linkOf(get, block) {
  const l = get('link');
  if (l) return l;
  const m = block.match(/<link\b[^>]*href=["']([^"']+)["']/i); // Atom <link href="">
  return m ? decodeEntities(m[1]) : '';
}
function cleanText(s) {
  if (s == null) return '';
  const t = String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeEntities(t).trim();
}
function htmlToText(html) {
  if (!html) return '';
  let t = String(html).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  t = t.replace(/<\s*br\s*\/?>/gi, ' ').replace(/<\/(p|div|li|h[1-6])>/gi, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t).replace(/\s+/g, ' ').trim();
  return t.slice(0, 600);
}
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#x0*26;/gi, '&').replace(/&#0*38;/g, '&');
}
function toNum(s) {
  if (s == null) return NaN;
  const m = String(s).replace(/\s/g, '').match(/[0-9]+(?:[.,][0-9]+)?/);
  return m ? parseFloat(m[0].replace(',', '.')) : NaN;
}
function canonAvail(s) {
  if (!s) return s;
  return String(s).trim().toLowerCase().replace(/\s+/g, '_');
}
function splitPrice(raw) {
  if (!raw) return { price: null, currency: null };
  const s = String(raw).trim();
  const amt = s.match(/([0-9]+(?:[.,][0-9]+)?)/);
  const cur = s.match(/\b([A-Za-z]{3})\b/);
  return { price: amt ? amt[1] : null, currency: cur ? cur[1].toUpperCase() : null };
}
function coverage(rec) {
  return {
    title: !!rec.title, description: !!rec.description, image: !!rec.image,
    price: !!rec.price, brand: !!rec.brand, gtin: !!rec.gtin,
  };
}
function toHttps(u) {
  if (!u) return u;
  if (u.startsWith('//')) return 'https:' + u;
  return u.replace(/^http:\/\//i, 'https://');
}

// ── Network ──────────────────────────────────────────────────────────────────
async function fetchText(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/xml,application/rss+xml,text/xml,text/tab-separated-values,text/csv,*/*' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error('Feed fetch failed (HTTP ' + r.status + ').');
  return await r.text();
}
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

// Named exports for offline parser tests (Vercel only invokes the default handler).
export { ingestGmcXml, ingestGmcTsv, normalizeShopify, splitPrice, htmlToText };
