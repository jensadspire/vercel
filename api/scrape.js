// ── Redis helper (same pattern as generate.js) ────────────────────────────────
async function redis(command, ...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
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

const CACHE_TTL = 60 * 60 * 24; // 24 hours in seconds

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  // ── Cache check — normalise URL to avoid case/trailing-slash misses ──────────
  const cacheKey = `rsa:scrape:${url.toLowerCase().replace(/\/$/, "")}`;

  try {
    const cached = await redis("GET", cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      console.log("Scrape cache HIT:", url);
      return res.status(200).json({ ...parsed, cached: true });
    }
  } catch (_) {
    // Cache miss or Redis unavailable — continue to live scrape
  }

  try {
    // ── Live scrape ────────────────────────────────────────────────────────────
    console.log("Scrape cache MISS — fetching live:", url);
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      signal: AbortSignal.timeout(8000),
    });

    const html = await response.text();

    // ── Language detection ────────────────────────────────────────────────────
    const tldLangMap = {
      "dk": "da", "se": "sv", "no": "nb", "fi": "fi", "is": "is",
      "de": "de", "at": "de", "ch": "de",
      "fr": "fr", "be": "fr", "it": "it", "es": "es",
      "pt": "pt", "mx": "es", "ar": "es", "co": "es",
      "nl": "nl", "pl": "pl", "cz": "cs", "sk": "sk",
      "hu": "hu", "ro": "ro", "hr": "hr", "bg": "bg",
      "gr": "el", "rs": "sr", "ua": "uk", "lt": "lt",
      "lv": "lv", "ee": "et", "si": "sl",
      "cn": "zh", "tw": "zh", "hk": "zh", "jp": "ja", "kr": "ko",
      "sa": "ar", "ae": "ar", "eg": "ar",
      "br": "pt", "ru": "ru", "tr": "tr",
    };

    const iso3Map = {
      "svk": "sk", "cze": "cs", "pol": "pl", "deu": "de", "fra": "fr",
      "ita": "it", "esp": "es", "nld": "nl", "por": "pt", "swe": "sv",
      "dan": "da", "nor": "nb", "fin": "fi", "hun": "hu", "ron": "ro",
      "hrv": "hr", "srp": "sr", "bul": "bg", "ell": "el", "ukr": "uk",
      "rus": "ru", "tur": "tr", "zho": "zh", "jpn": "ja", "kor": "ko",
      "ara": "ar", "isl": "is", "lit": "lt", "lav": "lv", "est": "et",
      "slk": "sk", "slv": "sl",
    };

    const langMap = {
      "de": "German", "de-de": "German", "de-at": "German", "de-ch": "German",
      "fr": "French", "fr-fr": "French", "fr-ch": "French", "fr-be": "French",
      "it": "Italian", "it-it": "Italian", "it-ch": "Italian",
      "es": "Spanish", "es-es": "Spanish", "es-mx": "Spanish", "es-ar": "Spanish",
      "pt": "Portuguese", "pt-br": "Portuguese", "pt-pt": "Portuguese",
      "ro": "Romanian", "ro-ro": "Romanian",
      "nl": "Dutch", "nl-nl": "Dutch", "nl-be": "Dutch",
      "sv": "Swedish", "sv-se": "Swedish",
      "da": "Danish", "da-dk": "Danish",
      "nb": "Norwegian", "no": "Norwegian", "nn": "Norwegian",
      "fi": "Finnish", "fi-fi": "Finnish",
      "is": "Icelandic", "is-is": "Icelandic",
      "pl": "Polish", "pl-pl": "Polish",
      "cs": "Czech", "cs-cz": "Czech",
      "sk": "Slovak", "sk-sk": "Slovak",
      "hr": "Croatian", "hr-hr": "Croatian",
      "sr": "Serbian", "sr-rs": "Serbian",
      "bg": "Bulgarian", "bg-bg": "Bulgarian",
      "uk": "Ukrainian", "uk-ua": "Ukrainian",
      "ru": "Russian", "ru-ru": "Russian",
      "sl": "Slovenian", "sl-si": "Slovenian",
      "hu": "Hungarian", "hu-hu": "Hungarian",
      "el": "Greek", "el-gr": "Greek",
      "tr": "Turkish", "tr-tr": "Turkish",
      "lt": "Lithuanian", "lt-lt": "Lithuanian",
      "lv": "Latvian", "lv-lv": "Latvian",
      "et": "Estonian", "et-ee": "Estonian",
      "zh": "Chinese", "zh-cn": "Chinese", "zh-tw": "Chinese", "zh-hk": "Chinese",
      "ja": "Japanese", "ja-jp": "Japanese",
      "ko": "Korean", "ko-kr": "Korean",
      "ar": "Arabic", "ar-sa": "Arabic", "ar-ae": "Arabic",
      "en": "English", "en-us": "English", "en-gb": "English", "en-au": "English",
    };

    const toLang = (code) => {
      if (!code) return null;
      const key = code.toLowerCase().split(",")[0].trim().replace("_", "-");
      return langMap[key] || langMap[key.split("-")[0]] || null;
    };

    const htmlLang = html.match(/<html[^>]+lang=["']([^"']+)["']/i)?.[1] || null;
    const ogLocale =
      html.match(/<meta[^>]+property=["']og:locale["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:locale["']/i)?.[1] || null;
    const headerLang = response.headers.get("content-language") || null;
    const hreflangMatches = [...html.matchAll(/hreflang=["']([^"']+)["']/gi)].map(m => m[1]);
    const hreflang = hreflangMatches.find(l => !l.startsWith("en") && l !== "x-default") ||
                     hreflangMatches[0] || null;
    const urlLang2 = url.match(/[\/](de|fr|it|es|nl|pt|pl|sv|da|fi|no|nb|cs|sk|hu|ro|hr|bg|el|sr|uk|ru|tr|zh|ja|ko|ar|is|lt|lv|et|sl|en)(?:[\/\-\_]|$)/i)?.[1]?.toLowerCase() || null;
    const urlLang3match = url.match(/[\/_](svk|cze|pol|deu|fra|ita|esp|nld|por|swe|dan|nor|fin|hun|ron|hrv|srp|bul|ell|ukr|rus|tur|zho|jpn|kor|ara|isl|lit|lav|est|slk|slv)(?:[\/_]|$)/i)?.[1]?.toLowerCase() || null;
    const urlLang = urlLang2 || (urlLang3match ? iso3Map[urlLang3match] : null) || null;
    const tld = url.match(/\.([a-z]{2})(\/|$)/i)?.[1]?.toLowerCase() || null;
    const tldLang = tld ? tldLangMap[tld] || null : null;
    const subdomainLang = url.match(/https?:\/\/(de|fr|it|es|nl|pt|pl|sv|da|fi|no|nb|cs|sk|hu|ro|hr|bg|el|sr|uk|ru|tr|zh|ja|ko|ar|is|lt|lv|et|sl)\./i)?.[1]?.toLowerCase() || null;

    const htmlLangIsEnglish = htmlLang && (htmlLang.toLowerCase().startsWith("en") || htmlLang.toLowerCase() === "en");
    let detectedCode;
    if (htmlLang && !htmlLangIsEnglish) {
      detectedCode = htmlLang;
    } else {
      detectedCode = urlLang || subdomainLang || ogLocale || headerLang || hreflang || tldLang || htmlLang || "en";
    }

    const language = toLang(detectedCode) || "English";

    const metaDesc =
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,}?)["']/i)?.[1] ||
      html.match(/<meta[^>]+content=["']([^"']{10,}?)["'][^>]+name=["']description["']/i)?.[1] || null;
    const title = html.match(/<title[^>]*>([^<]{3,})<\/title>/i)?.[1]?.trim() || null;
    const ogTitle =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1] || null;
    const ogDesc =
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)?.[1] || null;
    const ogSiteName =
      html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i)?.[1] || null;
    const h1 = html.match(/<h1[^>]*>([^<]{3,})<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() || null;

    const result = {
      language,
      detectedLangCode: detectedCode,
      title: ogTitle || title,
      metaDescription: ogDesc || metaDesc,
      siteName: ogSiteName,
      h1,
      signals: { htmlLang, ogLocale, headerLang, hreflang, urlLang, subdomainLang, tldLang, tld },
    };

    // ── Image extraction ──────────────────────────────────────────────────────
    const baseUrl = new URL(url).origin;
    const imgMatches = [...html.matchAll(/<img[^>]+>/gi)];
    
    // Also extract from data-src, data-lazy-src, srcset (lazy-loaded images)
    const lazySrcMatches = [...html.matchAll(/data-(?:src|lazy-src|lazy|original|zoom-image)=["']([^"']+)["']/gi)];
    const srcsetMatches = [...html.matchAll(/srcset=["']([^"']+)["']/gi)];
    // Extract highest-res from srcset (last entry tends to be largest)
    const srcsetUrls = srcsetMatches.flatMap(m => {
      const parts = m[1].split(',').map(s => s.trim().split(/\s+/)[0]);
      return parts.filter(u => u.startsWith('http') || u.startsWith('/'));
    });
    // Extract product image URLs from JSON/script tags (common in SPAs)
    const jsonImgMatches = [...html.matchAll(/"(?:image|img|photo|thumbnail|src)":\s*"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi)];
    const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1];

    // Score each image — product gallery thumbnails get priority
    const scoreImage = (tag, src) => {
      let score = 0;
      const t = tag.toLowerCase();
      const s = (src || '').toLowerCase();
      // Product gallery signals
      if (t.includes('data-index') || t.includes('data-thumb') || t.includes('gallery')) score += 5;
      if (t.includes('product') || s.includes('product')) score += 4;
      if (t.includes('data-zoom') || t.includes('data-large') || t.includes('data-full')) score += 3;
      if (t.includes('swiper') || t.includes('carousel') || t.includes('slider')) score += 3;
      if (s.includes('/products/') || s.includes('/shop/files/') || s.includes('/shop/product')) score += 3;
      if (s.includes('packshot') || s.includes('product-image') || s.includes('produktbild')) score += 4;
      if (s.includes('media.plantorama') || s.includes('cdn.') && s.includes('packshot')) score += 4;
      // Size signals — larger images preferred
      const widthMatch = t.match(/width=["'](\d+)["']/);
      if (widthMatch && parseInt(widthMatch[1]) > 400) score += 2;
      // Penalise non-product images
      if (s.includes('icon') || s.includes('logo') || s.includes('banner') || s.includes('badge')) score -= 5;
      if (s.includes('avatar') || s.includes('author') || s.includes('pixel')) score -= 5;
      if (s.includes('1x1') || s.includes('placeholder') || s.includes('blank')) score -= 10;
      // Penalise promotional/discount graphics
      if (s.includes('procent') || s.includes('percent') || s.includes('rabat') || s.includes('discount')) score -= 10;
      if (s.includes('navigation') || s.includes('nav-') || s.includes('noimageindex')) score -= 8;
      if (s.includes('rebate') || s.includes('offer') || s.includes('campaign') || s.includes('promo')) score -= 6;
      // Penalise landscape banners (wide x height ratio in URL)
      const dimsMatch = s.match(/(\d{3,4})x(\d{3,4})/);
      if (dimsMatch) {
        const w = parseInt(dimsMatch[1]), h = parseInt(dimsMatch[2]);
        if (w > h * 1.5) score -= 4; // wide landscape = likely banner
        if (w > 2000 && h < 800) score -= 6; // very wide banner
      }
      // Penalise hex colour codes in filename (promo graphics)
      if (/[0-9a-f]{6}/i.test(s.split('/').pop())) score -= 3;
      return score;
    };

    const extractSrc = (tag) => {
      const m = tag.match(/(?:src|data-src|data-lazy-src|data-zoom-src|data-large-src)=["']([^"']+)["']/i);
      return m ? m[1] : null;
    };

    // Combine all image sources
    const allImgTags = imgMatches.map(m => ({ tag: m[0], src: extractSrc(m[0]) }));
    const lazyImgs = lazySrcMatches.map(m => ({ tag: '', src: m[1] }));
    const jsonImgs = jsonImgMatches.map(m => ({ tag: '', src: m[1] }));
    const srcsetImgsList = srcsetUrls.map(src => ({ tag: '', src }));
    
    const scoredImages = [...allImgTags, ...lazyImgs, ...jsonImgs, ...srcsetImgsList].map(({ tag, src }) => {
      return { src, score: scoreImage(tag, src) };
    }).filter(({ src }) => src);

    const normaliseUrl = (src) => {
      if (!src) return null;
      if (src.startsWith('http')) return src;
      if (src.startsWith('//')) return 'https:' + src;
      if (src.startsWith('/')) return baseUrl + src;
      return null;
    };

    // Sort by score, put ogImage first, deduplicate
    scoredImages.sort((a, b) => b.score - a.score);

    const rawImages = [
      ogImage,
      ...scoredImages.map(({ src }) => src),
    ].filter(Boolean)
     .map(normaliseUrl)
     .filter(src => src && !src.includes('data:') && !src.includes('.svg') && !src.includes('placeholder'));

    // Deduplicate preserving order
    result.images = [...new Set(rawImages)].slice(0, 20);

    // Extract price from page
    const pricePatterns = [
      /<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+property=["']og:price:amount["'][^>]+content=["']([^"']+)["']/i,
      /class=["'][^"']*price[^"']*["'][^>]*>[^<]*?([\d]+[.,]\d{2})/i,
      /"price"\s*:\s*"?([\d]+[.,]\d{0,2})"?/i,
      /"price"\s*:\s*([\d]+\.?\d*)/i,
    ];
    let price = null;
    for (const pat of pricePatterns) {
      const m = html.match(pat);
      if (m && m[1] && parseFloat(m[1].replace(',', '.')) > 0) {
        price = m[1].trim();
        break;
      }
    }
    if (price) result.price = price;

    // ── Domain-specific gallery extraction ────────────────────────────────────
    // For sites that load galleries via JS/API, construct image URLs from patterns
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;
      const pathname = urlObj.pathname;

      // Sol og Strand — property photos follow /001_{houseId}_000_{seq}.jpg
      if (hostname.includes('sologstrand')) {
        const houseMatch = pathname.match(/\/hus\/([^/]+)/);
        if (houseMatch) {
          const houseId = houseMatch[1];
          // Pattern: 001_{houseId}_{galleryIndex}_{sizeVariant}.jpg
          // Iterate gallery index (3rd segment) with size variant 004 (medium-large)
          const SIZE = '004';
          const galleryImgs = Array.from({ length: 15 }, (_, i) =>
            `https://images.sologstrand.dk/001_${houseId}_${String(i+1).padStart(3,'0')}_${SIZE}.jpg`
          );
          // Validate with HEAD requests
          const validImgs = [];
          for (const imgUrl of galleryImgs) {
            try {
              const check = await fetch(imgUrl, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
              if (check.ok) validImgs.push(imgUrl);
              if (validImgs.length >= 12) break;
            } catch (_) {}
          }
          if (validImgs.length > 0) {
            result.images = [...validImgs, ...result.images].slice(0, 20);
            console.log('Sol og Strand gallery found:', validImgs.length, 'unique property photos');
          }
        }
      }

      // DanCenter — similar pattern
      if (hostname.includes('dancenter')) {
        const houseMatch = pathname.match(/\/([A-Z0-9]+)\/?$/);
        if (houseMatch) {
          const houseId = houseMatch[1];
          const galleryImgs = Array.from({ length: 8 }, (_, i) =>
            `https://img.dancenter.com/${houseId}_${i+1}.jpg`
          );
          result.images = [...galleryImgs, ...result.images].slice(0, 16);
        }
      }
    } catch (_) {}

    // ── Cache the result for 24 hours ─────────────────────────────────────────
    try {
      await redis("SET", cacheKey, JSON.stringify(result), "EX", CACHE_TTL);
      console.log("Scrape cached for 24h:", url);
    } catch (_) {
      // Cache write failure is non-fatal — result still returned to client
    }

    return res.status(200).json({ ...result, cached: false });

  } catch (err) {
    console.log("Scrape error for", url, ":", err.message);
    return res.status(200).json({
      language: "English",
      detectedLangCode: null,
      title: null,
      metaDescription: null,
      siteName: null,
      h1: null,
      error: err.message,
    });
  }
}
