/**
 * /api/sitemap — Domain URL Scanner v3
 *
 * Market detection priority:
 *   1. hreflang tags in homepage HTML  → authoritative full market list
 *   2. Locale segments in sitemap URLs → fallback grouping
 *
 * Scan flow:
 *   POST { domain }         → returns { mode:"locale", locales } OR { mode:"category", categories }
 *   POST { domain, locale } → scopes sitemap fetch to that locale, returns { mode:"category" }
 *
 * Change market: frontend caches hreflang locales — no re-scan needed
 */

// ── Locale map ────────────────────────────────────────────────────────────────
const LOCALE_MAP = {
  "en":    { flag: "🇬🇧", label: "English" },
  "de":    { flag: "🇩🇪", label: "German" },
  "fr":    { flag: "🇫🇷", label: "French" },
  "es":    { flag: "🇪🇸", label: "Spanish" },
  "it":    { flag: "🇮🇹", label: "Italian" },
  "nl":    { flag: "🇳🇱", label: "Dutch" },
  "pt":    { flag: "🇵🇹", label: "Portuguese" },
  "sv":    { flag: "🇸🇪", label: "Swedish" },
  "da":    { flag: "🇩🇰", label: "Danish" },
  "nb":    { flag: "🇳🇴", label: "Norwegian" },
  "fi":    { flag: "🇫🇮", label: "Finnish" },
  "pl":    { flag: "🇵🇱", label: "Polish" },
  "cs":    { flag: "🇨🇿", label: "Czech" },
  "sk":    { flag: "🇸🇰", label: "Slovak" },
  "hu":    { flag: "🇭🇺", label: "Hungarian" },
  "ro":    { flag: "🇷🇴", label: "Romanian" },
  "tr":    { flag: "🇹🇷", label: "Turkish" },
  "ru":    { flag: "🇷🇺", label: "Russian" },
  "ja":    { flag: "🇯🇵", label: "Japanese" },
  "zh":    { flag: "🇨🇳", label: "Chinese" },
  "ko":    { flag: "🇰🇷", label: "Korean" },
  "ar":    { flag: "🇸🇦", label: "Arabic" },
  "uk":    { flag: "🇬🇧", label: "United Kingdom" },
  "us":    { flag: "🇺🇸", label: "United States" },
  "au":    { flag: "🇦🇺", label: "Australia" },
  "ca":    { flag: "🇨🇦", label: "Canada" },
  "ie":    { flag: "🇮🇪", label: "Ireland" },
  "at":    { flag: "🇦🇹", label: "Austria" },
  "ch":    { flag: "🇨🇭", label: "Switzerland" },
  "be":    { flag: "🇧🇪", label: "Belgium" },
  "se":    { flag: "🇸🇪", label: "Sweden" },
  "no":    { flag: "🇳🇴", label: "Norway" },
  "dk":    { flag: "🇩🇰", label: "Denmark" },
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

function isLocaleSegment(seg) {
  const s = seg.toLowerCase().replace(/_/g, "-");
  return !!LOCALE_MAP[s];
}

function getLocaleInfo(seg) {
  const s = seg.toLowerCase().replace(/_/g, "-");
  return LOCALE_MAP[s] || { flag: "🌐", label: seg.toUpperCase() };
}

// ── Config ────────────────────────────────────────────────────────────────────
const MAX_URLS      = 300;
const MAX_PER_CAT   = 50;
const FETCH_TIMEOUT = 9000;

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

// ── Fetch ─────────────────────────────────────────────────────────────────────
async function fetchUrl(url, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en,de;q=0.8,da;q=0.6",
        ...extraHeaders,
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    const body = await res.text();
    return { code: res.status, body, finalUrl: res.url };
  } catch (e) {
    clearTimeout(timer);
    return { code: 0, body: null, error: e.message };
  }
}

// ── Utils ─────────────────────────────────────────────────────────────────────
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
    return { origin: "https://" + input.trim().replace(/^https?:\/\//, "").replace(/\/$/, ""), localePrefix: null };
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
  return body && (
    body.includes("cf-browser-verification") ||
    body.includes("challenge-platform") ||
    body.includes("cf_chl_") ||
    body.includes("Just a moment") ||
    body.includes("_cf_chl")
  );
}

function isBot403(body) {
  return body && (
    body.includes("Access Denied") ||
    body.includes("403 Forbidden") ||
    body.includes("Bot detection") ||
    body.includes("automated access")
  );
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

// ── hreflang parser — the key to finding ALL markets ─────────────────────────
function extractHreflang(html, origin) {
  const results = [];
  const seen = new Set();

  // Match <link rel="alternate" hreflang="..." href="..."> in any attribute order
  const re = /<link[^>]+hreflang=["']([^"']+)["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
  const re2 = /<link[^>]+href=["']([^"']+)["'][^>]*hreflang=["']([^"']+)["'][^>]*>/gi;

  function process(lang, href) {
    if (lang === "x-default") return;
    const langKey = lang.toLowerCase().replace(/_/g, "-");
    if (seen.has(langKey)) return;

    // Extract path prefix from href — handle double-locale slugs like /sk/sk/ or /en/gb/
    let pathPrefix = null;
    try {
      const u = new URL(href.startsWith("http") ? href : origin + href);
      const segs = u.pathname.split("/").filter(Boolean);
      if (segs.length >= 2 &&
          segs[0].length <= 3 && segs[1].length <= 3 &&
          (segs[0] === segs[1] || isLocaleSegment(segs[0]) && isLocaleSegment(segs[1]))) {
        // Double-locale pattern: /sk/sk/ or /en/gb/ — use full two-segment prefix
        pathPrefix = "/" + segs[0].toLowerCase() + "/" + segs[1].toLowerCase();
      } else if (segs.length >= 1) {
        pathPrefix = "/" + segs[0].toLowerCase();
      }
    } catch {}

    seen.add(langKey);
    results.push({ lang: langKey, href, pathPrefix });
  }

  let m;
  while ((m = re.exec(html)) !== null)  process(m[1], m[2]);
  while ((m = re2.exec(html)) !== null) process(m[2], m[1]);

  // Convert to locale objects
  return results.map(r => {
    const info = getLocaleInfo(r.lang) || getLocaleInfo(r.pathPrefix?.replace("/", "") || "");
    return {
      slug: r.pathPrefix ? r.pathPrefix.replace("/", "") : r.lang,
      lang: r.lang,
      href: r.href,
      flag: info.flag || "🌐",
      label: info.label || r.lang.toUpperCase(),
    };
  }).filter(r => r.slug);
}

// ── Sitemap collection ────────────────────────────────────────────────────────
async function getSitemapsFromRobots(origin) {
  const { body } = await fetchUrl(origin + "/robots.txt");
  if (!body) return [];
  return body.split("\n")
    .map(l => l.trim())
    .filter(l => l.toLowerCase().startsWith("sitemap:"))
    .map(l => l.substring(8).trim())
    .filter(u => u.startsWith("http"));
}

async function collectFromSitemapXml(xml, sourceUrl, visited = new Set(), maxChildren = 30) {
  const all = [];
  visited.add(sourceUrl);
  if (isSitemapIndex(xml)) {
    const children = extractLocs(xml).filter(u => u.endsWith(".xml"));
    let fetched = 0;
    for (const child of children) {
      if (visited.has(child)) continue;
      if (fetched >= maxChildren) break;
      visited.add(child);
      fetched++;
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

// Try to collect URLs scoped to a specific locale path
async function collectScopedUrls(origin, localeSlug) {
  const localePath = "/" + localeSlug;
  let allUrls = [];
  let method = "";

  // Try locale-specific sitemap paths first — many variations
  const slugFlat = localeSlug.replace("/", "-");
  const slugUnder = localeSlug.replace("/", "_");
  const localeSitemapPaths = [
    `${localePath}/sitemap.xml`,
    `${localePath}/sitemap_index.xml`,
    `${localePath}/sitemap-index.xml`,
    `${localePath}/sitemaps/sitemap.xml`,
    `/sitemap_${slugFlat}.xml`,
    `/sitemap-${slugFlat}.xml`,
    `/sitemap_${slugUnder}.xml`,
    `/sitemap_${localeSlug.split("/")[0]}.xml`,
    `/sitemaps/${slugFlat}-sitemap.xml`,
  ];

  for (const path of localeSitemapPaths) {
    const { body, code } = await fetchUrl(origin + path);
    if (!body || !isXml(body) || code !== 200) continue;
    const urls = await collectFromSitemapXml(body, origin + path, new Set(), 8);
    const scoped = urls.filter(u => u.includes(localePath));
    if (scoped.length > 0) { allUrls = scoped; method = "locale sitemap"; break; }
  }

  // Fall back to root sitemap, filter by locale
  if (allUrls.length === 0) {
    const robotsSitemaps = await getSitemapsFromRobots(origin);
    for (const sm of robotsSitemaps) {
      const { body } = await fetchUrl(sm);
      if (!body || !isXml(body)) continue;
      const urls = await collectFromSitemapXml(body, sm);
      const scoped = urls.filter(u => {
        const segs = getPathSegments(u);
        const slugParts = localeSlug.split("/").filter(Boolean);
        return slugParts.every((part, i) => segs[i] && segs[i].toLowerCase() === part);
      });
      allUrls.push(...scoped);
      if (allUrls.length >= MAX_URLS) break;
    }
    if (allUrls.length > 0) method = "robots.txt sitemap";
  }

  if (allUrls.length === 0) {
    for (const path of SITEMAP_PATHS) {
      const { body, code } = await fetchUrl(origin + path);
      if (!body || !isXml(body) || code !== 200) continue;
      const urls = await collectFromSitemapXml(body, origin + path);
      const scoped = urls.filter(u => {
        const segs = getPathSegments(u);
        const slugParts = localeSlug.split("/").filter(Boolean);
        return slugParts.every((part, i) => segs[i] && segs[i].toLowerCase() === part);
      });
      if (scoped.length > 0) { allUrls = scoped; method = "sitemap XML"; break; }
    }
  }

  return { allUrls: allUrls.slice(0, MAX_URLS), method };
}

// Full root-level collection (no locale scope)
async function collectAllUrls(origin) {
  let allUrls = [];
  let method = "";
  let homeBody = null;
  let homeBlocked = null;

  // Robots.txt sitemaps first
  const robotsSitemaps = await getSitemapsFromRobots(origin);
  for (const sm of robotsSitemaps) {
    const { body } = await fetchUrl(sm);
    if (!body || !isXml(body)) continue;
    const urls = await collectFromSitemapXml(body, sm);
    allUrls.push(...urls);
    if (allUrls.length >= MAX_URLS) break;
  }
  if (allUrls.length > 0) method = "robots.txt sitemap";

  // Known paths
  if (allUrls.length === 0) {
    for (const path of SITEMAP_PATHS) {
      const { body, code } = await fetchUrl(origin + path);
      if (!body || !isXml(body) || code === 403) continue;
      const urls = await collectFromSitemapXml(body, origin + path);
      if (urls.length > 0) { allUrls = urls; method = "sitemap XML"; break; }
    }
  }

  // Homepage — always fetch for hreflang even if we got sitemap URLs
  const home = await fetchUrl(origin + "/");
  if (home.code === 0)       homeBlocked = "unreachable";
  else if (home.code >= 400) homeBlocked = isCloudflare(home.body) ? "cloudflare" : "blocked";
  else                       homeBody = home.body;

  // Nav crawl as last resort
  if (allUrls.length === 0 && homeBody && !isCloudflare(homeBody)) {
    const navLinks = extractNavLinksFromHtml(homeBody, origin);
    if (navLinks.length > 0) { allUrls = navLinks; method = "homepage navigation"; }
  }

  return { allUrls: allUrls.slice(0, MAX_URLS), method, homeBody, homeBlocked };
}

function extractNavLinksFromHtml(html, origin) {
  const host = origin.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const seen = new Set();
  const candidates = [];
  const re = /href=["']([^"'#?][^"']*?)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1].trim();
    if (href.startsWith("/")) href = origin + href;
    else if (!href.startsWith("http")) continue;
    try {
      const hrefHost = new URL(href).hostname.replace(/^www\./, "");
      if (!hrefHost.includes(host.split("/")[0])) continue;
    } catch { continue; }
    href = href.split("?")[0].split("#")[0];
    if (isExcluded(href)) continue;
    const d = getDepth(href);
    if (d < 1 || d > 4) continue;
    if (!seen.has(href)) { seen.add(href); candidates.push(href); }
  }
  return candidates;
}

// ── Locale detection from sitemap URLs ───────────────────────────────────────
function detectLocalesFromUrls(allUrls) {
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

// ── Category grouping ─────────────────────────────────────────────────────────
function groupIntoCategories(allUrls, localeSlug) {
  const slugParts = localeSlug ? localeSlug.split("/").filter(Boolean) : [];
  const scoped = localeSlug
    ? allUrls.filter(u => {
        const segs = getPathSegments(u);
        return slugParts.every((part, i) => segs[i] && segs[i].toLowerCase() === part);
      })
    : allUrls;

  const filtered = scoped.filter(u => !isExcluded(u));
  if (!filtered.length) return null;

  const groups = {};
  for (const url of filtered) {
    const segs = getPathSegments(url);
    // Start after known locale prefix, then skip any additional locale-like segments
    // e.g. /de/de_de/kleidung → slugParts=["de"], skip "de_de" too → catSeg="kleidung"
    let catIdx = slugParts.length;
    while (catIdx < segs.length && isLocaleSegment(segs[catIdx])) catIdx++;
    const catSeg = segs[catIdx];
    if (!catSeg) continue;
    if (localeSlug && catIdx >= segs.length) continue; // nothing after locale segments
    if (!groups[catSeg]) groups[catSeg] = [];
    groups[catSeg].push(url);
  }

  const scored = Object.entries(groups).map(([slug, urls]) => {
    const kwCount = urls.filter(hasProductKeyword).length;
    const avgDepth = urls.map(getDepth).reduce((a, b) => a + b, 0) / urls.length;
    const score =
      (kwCount / Math.max(urls.length, 1)) * 40 +
      Math.min(urls.length / 5, 10) +
      (avgDepth >= 2 && avgDepth <= 5 ? 10 : 0);
    return { slug, urls, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
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

  const { domain: rawDomain, locale } = req.body || {};
  if (!rawDomain) return res.status(400).json({ error: "domain is required" });

  const { origin, localePrefix: userLocalePrefix } = parseDomainInput(rawDomain);

  // ── Scoped mode: user already chose a market ────────────────────────────────
  const effectiveLocale = userLocalePrefix
    ? userLocalePrefix.replace("/", "")
    : locale ? locale.replace(/^\//, "") : null;

  if (effectiveLocale) {
    const { allUrls, method } = await collectScopedUrls(origin, effectiveLocale);

    if (allUrls.length === 0) {
      return res.json({
        error: "No URLs found for this market",
        diagnosis: `Could not find product URLs under /${effectiveLocale}. This site may require the manual paste method.`,
        fallback: true,
      });
    }

    const categories = groupIntoCategories(allUrls, effectiveLocale);
    if (!categories || categories.length === 0) {
      return res.json({
        error: "No categories found",
        diagnosis: `Found ${allUrls.length} URLs under /${effectiveLocale} but couldn't identify product categories.`,
        fallback: true,
      });
    }

    return res.json({ mode: "category", categories, method, total: allUrls.length, locale: effectiveLocale });
  }

  // ── Full scan mode ──────────────────────────────────────────────────────────
  const { allUrls, method, homeBody, homeBlocked } = await collectAllUrls(origin);

  // ── Step 1: Try hreflang from homepage HTML — authoritative market list ─────
  if (homeBody) {
    const hreflangLocales = extractHreflang(homeBody, origin);
    if (hreflangLocales.length >= 2) {
      // Deduplicate by slug, keep unique path prefixes
      const seen = new Set();
      const unique = hreflangLocales.filter(l => {
        if (seen.has(l.slug)) return false;
        seen.add(l.slug);
        return true;
      });
      return res.json({
        mode: "locale",
        locales: unique,
        method: "hreflang tags",
        total: allUrls.length,
        domain: origin,
        source: "hreflang", // tells frontend to cache this list
      });
    }
  }

  // ── Step 2: Locale detection from sitemap URLs ──────────────────────────────
  if (allUrls.length > 0) {
    const urlLocales = detectLocalesFromUrls(allUrls);

    if (urlLocales.length >= 2) {
      return res.json({
        mode: "locale",
        locales: urlLocales,
        method,
        total: allUrls.length,
        domain: origin,
        source: "sitemap",
      });
    }

    // Single locale or no locale — try categories directly
    const singleLocale = urlLocales.length === 1 ? urlLocales[0].slug : null;
    const categories = groupIntoCategories(allUrls, singleLocale);

    if (categories && categories.length > 0) {
      // Still show locale picker if we found a single locale — user may want another market
      if (urlLocales.length === 1) {
        return res.json({
          mode: "locale",
          locales: urlLocales,
          method,
          total: allUrls.length,
          domain: origin,
          source: "sitemap",
          note: "single_locale",
        });
      }
      return res.json({ mode: "category", categories, method, total: allUrls.length, locale: null });
    }
  }

  // ── Nothing worked ──────────────────────────────────────────────────────────
  if (homeBlocked === "cloudflare") {
    return res.json({
      error: "Cloudflare protected",
      diagnosis: "This site uses Cloudflare bot protection which blocks automated scanning. Use the manual paste method to add URLs directly.",
      fallback: true,
    });
  }
  if (homeBlocked === "blocked") {
    return res.json({
      error: "Site blocked scanner",
      diagnosis: "This site is blocking automated requests. Use the manual paste method to add URLs directly.",
      fallback: true,
    });
  }
  if (homeBlocked === "unreachable") {
    return res.json({ error: "Domain unreachable", diagnosis: "Check the URL and try again." });
  }

  return res.json({
    error: "No URLs found",
    diagnosis: "Could not find a sitemap or navigation links. Use the manual paste method for this site.",
    fallback: true,
  });
}
