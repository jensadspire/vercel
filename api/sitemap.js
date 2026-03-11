/**
 * /api/sitemap — Domain URL Scanner v2
 * Locale-aware: detects language/country path segments first,
 * then scopes category grouping within selected locale.
 *
 * POST body:
 *   { domain }              -> full scan, returns locales OR categories
 *   { domain, locale }      -> scoped scan within locale prefix, returns categories
 *
 * Responses:
 *   { mode: "locale",    locales: [{ slug, flag, label, count }] }
 *   { mode: "category",  categories: [{ slug, name, urls, count }], method, total }
 *   { error, diagnosis, fallback? }
 */

const LOCALE_MAP = {
  "en": { flag: "🇬🇧", label: "English" },
  "de": { flag: "🇩🇪", label: "German" },
  "fr": { flag: "🇫🇷", label: "French" },
  "es": { flag: "🇪🇸", label: "Spanish" },
  "it": { flag: "🇮🇹", label: "Italian" },
  "nl": { flag: "🇳🇱", label: "Dutch" },
  "pt": { flag: "🇵🇹", label: "Portuguese" },
  "sv": { flag: "🇸🇪", label: "Swedish" },
  "da": { flag: "🇩🇰", label: "Danish" },
  "nb": { flag: "🇳🇴", label: "Norwegian" },
  "fi": { flag: "🇫🇮", label: "Finnish" },
  "pl": { flag: "🇵🇱", label: "Polish" },
  "cs": { flag: "🇨🇿", label: "Czech" },
  "sk": { flag: "🇸🇰", label: "Slovak" },
  "hu": { flag: "🇭🇺", label: "Hungarian" },
  "ro": { flag: "🇷🇴", label: "Romanian" },
  "tr": { flag: "🇹🇷", label: "Turkish" },
  "ru": { flag: "🇷🇺", label: "Russian" },
  "ja": { flag: "🇯🇵", label: "Japanese" },
  "zh": { flag: "🇨🇳", label: "Chinese" },
  "ko": { flag: "🇰🇷", label: "Korean" },
  "ar": { flag: "🇸🇦", label: "Arabic" },
  "uk": { flag: "🇬🇧", label: "United Kingdom" },
  "us": { flag: "🇺🇸", label: "United States" },
  "au": { flag: "🇦🇺", label: "Australia" },
  "ca": { flag: "🇨🇦", label: "Canada" },
  "ie": { flag: "🇮🇪", label: "Ireland" },
  "at": { flag: "🇦🇹", label: "Austria" },
  "ch": { flag: "🇨🇭", label: "Switzerland" },
  "be": { flag: "🇧🇪", label: "Belgium" },
  "se": { flag: "🇸🇪", label: "Sweden" },
  "no": { flag: "🇳🇴", label: "Norway" },
  "dk": { flag: "🇩🇰", label: "Denmark" },
  "en-gb": { flag: "🇬🇧", label: "English (UK)" },
  "en-us": { flag: "🇺🇸", label: "English (US)" },
  "en-au": { flag: "🇦🇺", label: "English (AU)" },
  "en-ca": { flag: "🇨🇦", label: "English (CA)" },
  "en-ie": { flag: "🇮🇪", label: "English (IE)" },
  "de-de": { flag: "🇩🇪", label: "German (DE)" },
  "de-at": { flag: "🇦🇹", label: "German (AT)" },
  "de-ch": { flag: "🇨🇭", label: "German (CH)" },
  "fr-fr": { flag: "🇫🇷", label: "French (FR)" },
  "fr-be": { flag: "🇧🇪", label: "French (BE)" },
  "fr-ch": { flag: "🇨🇭", label: "French (CH)" },
  "fr-ca": { flag: "🇨🇦", label: "French (CA)" },
  "es-es": { flag: "🇪🇸", label: "Spanish (ES)" },
  "es-mx": { flag: "🇲🇽", label: "Spanish (MX)" },
  "es-ar": { flag: "🇦🇷", label: "Spanish (AR)" },
  "it-it": { flag: "🇮🇹", label: "Italian (IT)" },
  "nl-nl": { flag: "🇳🇱", label: "Dutch (NL)" },
  "nl-be": { flag: "🇧🇪", label: "Dutch (BE)" },
  "pt-pt": { flag: "🇵🇹", label: "Portuguese (PT)" },
  "pt-br": { flag: "🇧🇷", label: "Portuguese (BR)" },
  "sv-se": { flag: "🇸🇪", label: "Swedish (SE)" },
  "da-dk": { flag: "🇩🇰", label: "Danish (DK)" },
  "nb-no": { flag: "🇳🇴", label: "Norwegian (NO)" },
  "pl-pl": { flag: "🇵🇱", label: "Polish (PL)" },
  "cs-cz": { flag: "🇨🇿", label: "Czech (CZ)" },
  "ru-ru": { flag: "🇷🇺", label: "Russian (RU)" },
  "tr-tr": { flag: "🇹🇷", label: "Turkish (TR)" },
  "ja-jp": { flag: "🇯🇵", label: "Japanese (JP)" },
  "zh-cn": { flag: "🇨🇳", label: "Chinese (CN)" },
  "zh-tw": { flag: "🇹🇼", label: "Chinese (TW)" },
  "ko-kr": { flag: "🇰🇷", label: "Korean (KR)" },
  "ar-sa": { flag: "🇸🇦", label: "Arabic (SA)" },
};

const LOCALE_PATTERN = /^[a-z]{2}(?:[-_][a-z]{2,4})?$/i;

function isLocaleSegment(seg) {
  const s = seg.toLowerCase().replace(/_/g, "-");
  return !!LOCALE_MAP[s];
}

function getLocaleInfo(seg) {
  const s = seg.toLowerCase().replace(/_/g, "-");
  return LOCALE_MAP[s] || { flag: "🌐", label: seg.toUpperCase() };
}

const MAX_URLS    = 300;
const MAX_PER_CAT = 50;
const FETCH_TIMEOUT = 8000;

const SITEMAP_PATHS = [
  "/sitemap.xml","/sitemap_index.xml","/sitemap-index.xml",
  "/sitemaps/sitemap.xml","/sitemap/sitemap.xml",
  "/sitemap_products.xml","/sitemap_product.xml","/sitemap-products.xml",
  "/sitemap_categories.xml","/sitemap_category.xml","/sitemap-categories.xml",
  "/sitemap_collections.xml","/sitemap_pages.xml",
  "/sitemap1.xml","/sitemap2.xml",
  "/wp-sitemap.xml","/page-sitemap.xml","/product-sitemap.xml",
  "/category-sitemap.xml","/post-sitemap.xml",
];

const PRODUCT_KEYWORDS = [
  "/product","/produkt","/products","/produkter",
  "/category","/kategori","/categories","/kategorier",
  "/shop","/store","/butik","/collection","/kollektion","/collections",
  "/item","/vare","/varer","/p/","/c/","/cat/",
  "/clothes","/clothing","/kleidung","/toej","/mode",
  "/shoes","/schuhe","/fodtoej","/sko",
  "/accessories","/accessoires",
  "/bags","/tasker","/taske",
  "/sport","/outdoor","/fitness",
  "/beauty","/makeup","/hudpleje","/parfume",
  "/elektronik","/mobil","/have","/bolig",
  "/dame","/herre","/barn","/baby",
  "/tilbud","/udsalg","/outlet","/sale",
];

const EXCLUDE_KEYWORDS = [
  "/faq","/help","/support","/kundeservice",
  "/login","/account","/konto","/checkout","/cart","/kurv",
  "/tag/","/author/","/cookie","/privacy","/gdpr",
  "/404","/search","/soeg","/job","/career",
  "/kontakt","/contact","/about","/om-os",
  "/blog","/news","/nyhed","/newsletter",
  "/sitemap","/pages/account",
];

const BINARY_EXT = [".jpg",".jpeg",".png",".gif",".pdf",".xml",".css",".js",".svg",".webp",".ico",".woff",".woff2"];

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
    const body = await res.text();
    return { code: res.status, body };
  } catch (e) {
    clearTimeout(timer);
    return { code: 0, body: null, error: e.message };
  }
}

function normalizeDomain(input) {
  let d = input.trim().toLowerCase();
  if (!d.startsWith("http://") && !d.startsWith("https://")) d = "https://" + d;
  return d.replace(/\/$/, "");
}

function parseDomainInput(input) {
  let raw = input.trim();
  if (!raw.startsWith("http://") && !raw.startsWith("https://")) raw = "https://" + raw;
  raw = raw.replace(/\/$/, "");
  try {
    const u = new URL(raw);
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length >= 1 && isLocaleSegment(segs[0])) {
      return { origin: u.origin, localePrefix: "/" + segs[0].toLowerCase().replace(/_/g, "-") };
    }
    return { origin: u.origin, localePrefix: null };
  } catch {
    return { origin: normalizeDomain(input), localePrefix: null };
  }
}

function isExcluded(url) {
  const l = url.toLowerCase();
  if (BINARY_EXT.some(ext => l.endsWith(ext))) return true;
  return EXCLUDE_KEYWORDS.some(k => l.includes(k));
}

function hasProductKeyword(url) {
  return PRODUCT_KEYWORDS.some(k => url.toLowerCase().includes(k));
}

function isXml(body) {
  return body && (body.trimStart().startsWith("<?xml") || body.includes("<urlset") || body.includes("<sitemapindex"));
}

function isCloudflare(body) {
  return body && (body.includes("cf-browser-verification") || body.includes("challenge-platform") || body.includes("cf_chl_") || body.includes("Just a moment"));
}

function extractLocs(xml) {
  return (xml.match(/<loc>(.*?)<\/loc>/g) || []).map(m => m.replace(/<\/?loc>/g, "").trim());
}

function isSitemapIndex(xml) {
  return xml.includes("<sitemapindex") || (xml.includes("<sitemap>") && xml.includes("<loc>"));
}

function getPathSegments(url) {
  try { return new URL(url).pathname.split("/").filter(Boolean); }
  catch { return []; }
}

function getDepth(url) { return getPathSegments(url).length; }

async function getSitemapsFromRobots(origin) {
  const { body } = await fetchUrl(origin + "/robots.txt");
  if (!body) return [];
  return body.split("\n")
    .map(l => l.trim())
    .filter(l => l.toLowerCase().startsWith("sitemap:"))
    .map(l => l.substring(8).trim())
    .filter(u => u.startsWith("http"));
}

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
      if (all.length >= MAX_URLS) break;
    }
  } else {
    all.push(...extractLocs(xml).filter(u => !u.endsWith(".xml")));
  }
  return all;
}

function extractNavLinks(html, origin) {
  const host = origin.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const seen = new Set();
  const candidates = [];
  const re = /href=["']([^"'#?][^"']*?)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1].trim();
    if (href.startsWith("/")) href = origin + href;
    else if (!href.startsWith("http")) continue;
    const hrefHost = href.replace(/^https?:\/\//, "").replace(/^www\./, "");
    if (!hrefHost.startsWith(host)) continue;
    href = href.split("?")[0].split("#")[0];
    if (isExcluded(href)) continue;
    const d = getDepth(href);
    if (d < 1 || d > 4) continue;
    if (!seen.has(href)) { seen.add(href); candidates.push(href); }
  }
  return candidates;
}

async function collectAllUrls(origin) {
  let allUrls = [];
  let method = "";
  const robotsSitemaps = await getSitemapsFromRobots(origin);
  for (const sm of robotsSitemaps) {
    const { body } = await fetchUrl(sm);
    if (!body || !isXml(body)) continue;
    const urls = await collectFromSitemapXml(body, sm);
    allUrls.push(...urls);
    if (allUrls.length >= MAX_URLS) break;
  }
  if (allUrls.length > 0) method = "robots.txt sitemap";
  if (allUrls.length === 0) {
    for (const path of SITEMAP_PATHS) {
      const { body, code } = await fetchUrl(origin + path);
      if (!body || !isXml(body) || code === 403) continue;
      const urls = await collectFromSitemapXml(body, origin + path);
      allUrls.push(...urls);
      if (allUrls.length > 0) { method = "sitemap XML"; break; }
    }
  }
  if (allUrls.length === 0) {
    const { body } = await fetchUrl(origin + "/");
    if (body && !isCloudflare(body)) {
      allUrls = extractNavLinks(body, origin);
      if (allUrls.length > 0) method = "homepage navigation";
    }
  }
  return { allUrls: allUrls.slice(0, MAX_URLS), method };
}

function detectLocales(allUrls) {
  const counts = {};
  for (const url of allUrls) {
    const segs = getPathSegments(url);
    if (segs.length >= 1 && isLocaleSegment(segs[0])) {
      const seg = segs[0].toLowerCase().replace(/_/g, "-");
      counts[seg] = (counts[seg] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([slug, count]) => ({ slug, ...getLocaleInfo(slug), count }));
}

function groupIntoCategories(allUrls, localePrefix) {
  const locSeg = localePrefix ? localePrefix.replace(/^\//, "").toLowerCase() : null;
  const scoped = locSeg
    ? allUrls.filter(u => {
        const segs = getPathSegments(u);
        return segs.length >= 1 && segs[0].toLowerCase().replace(/_/g, "-") === locSeg;
      })
    : allUrls;

  const filtered = scoped.filter(u => !isExcluded(u));
  if (!filtered.length) return null;

  const groups = {};
  for (const url of filtered) {
    const segs = getPathSegments(url);
    const catIdx = locSeg && segs[0] && segs[0].toLowerCase().replace(/_/g, "-") === locSeg ? 1 : 0;
    const catSeg = segs[catIdx];
    if (!catSeg || isLocaleSegment(catSeg)) continue;
    if (locSeg && segs.length === catIdx + 1) continue; // skip locale-root-level
    if (!groups[catSeg]) groups[catSeg] = [];
    groups[catSeg].push(url);
  }

  const scored = Object.entries(groups).map(([slug, urls]) => {
    const kwCount = urls.filter(hasProductKeyword).length;
    const depths = urls.map(getDepth);
    const avgDepth = depths.reduce((a, b) => a + b, 0) / depths.length;
    const score =
      (kwCount / Math.max(urls.length, 1)) * 40 +
      Math.min(urls.length / 5, 10) +
      (avgDepth >= 2 && avgDepth <= 5 ? 10 : 0);
    return { slug, urls, score };
  });

  scored.sort((a, b) => b.score - a.score);

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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { domain: rawDomain, locale } = req.body || {};
  if (!rawDomain) return res.status(400).json({ error: "domain is required" });

  const { origin, localePrefix: userLocalePrefix } = parseDomainInput(rawDomain);

  const home = await fetchUrl(origin + "/");
  if (home.code === 0)   return res.json({ error: "Domain unreachable", diagnosis: "DNS or connection error — check the URL and try again" });
  if (home.code === 403) return res.json({ error: "Access blocked", diagnosis: "Server is blocking automated requests (403)" });
  if (home.code === 429) return res.json({ error: "Rate limited", diagnosis: "Too many requests — try again in a few seconds" });
  if (home.code >= 500)  return res.json({ error: "Server error", diagnosis: `Site returned ${home.code} — may be temporarily down` });
  if (home.body && isCloudflare(home.body)) {
    return res.json({ error: "Cloudflare protected", diagnosis: "This site uses Cloudflare bot protection — use the Apps Script method instead", fallback: true });
  }

  const { allUrls, method } = await collectAllUrls(origin);
  if (allUrls.length === 0) {
    return res.json({ error: "No URLs found", diagnosis: "Could not find a sitemap or navigation links. Try the Apps Script method.", fallback: true });
  }

  // If user typed a locale path OR API caller passed locale — go straight to categories
  const effectiveLocale = userLocalePrefix || (locale ? "/" + locale.replace(/^\//, "") : null);
  if (effectiveLocale) {
    const categories = groupIntoCategories(allUrls, effectiveLocale);
    if (!categories || categories.length === 0) {
      return res.json({ error: "No categories found", diagnosis: `No product categories detected under ${effectiveLocale}` });
    }
    return res.json({ mode: "category", categories, method, total: allUrls.length, locale: effectiveLocale });
  }

  // Auto-detect locales
  const locales = detectLocales(allUrls);
  if (locales.length >= 2) {
    return res.json({ mode: "locale", locales, method, total: allUrls.length, domain: origin });
  }

  // Single locale or no locale structure — go straight to categories
  const singleLocale = locales.length === 1 ? "/" + locales[0].slug : null;
  const categories = groupIntoCategories(allUrls, singleLocale);
  if (!categories || categories.length === 0) {
    return res.json({ error: "No categories found", diagnosis: "Found URLs but could not identify product/category structure", fallback: true });
  }
  return res.json({ mode: "category", categories, method, total: allUrls.length, locale: singleLocale });
}
