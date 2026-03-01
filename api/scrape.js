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
