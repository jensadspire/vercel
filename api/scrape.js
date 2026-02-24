export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  try {
    // Fetch the page HTML with a realistic browser user agent
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

    // TLD → language map (used as fallback for country-code domains)
    const tldLangMap = {
      "dk": "da", "se": "sv", "no": "nb", "fi": "fi",
      "de": "de", "at": "de", "ch": "de",
      "fr": "fr", "be": "fr",
      "it": "it", "es": "es", "nl": "nl",
      "pt": "pt", "pl": "pl", "cz": "cs",
      "hu": "hu", "ro": "ro",
    };

    // Full language name map
    const langMap = {
      "de": "German", "de-de": "German", "de-at": "German", "de-ch": "German",
      "fr": "French", "fr-fr": "French", "fr-ch": "French", "fr-be": "French",
      "it": "Italian", "it-it": "Italian", "it-ch": "Italian",
      "es": "Spanish", "es-es": "Spanish", "es-mx": "Spanish",
      "nl": "Dutch", "nl-nl": "Dutch", "nl-be": "Dutch",
      "pt": "Portuguese", "pt-br": "Portuguese", "pt-pt": "Portuguese",
      "pl": "Polish", "sv": "Swedish", "da": "Danish",
      "fi": "Finnish", "no": "Norwegian", "nb": "Norwegian",
      "cs": "Czech", "hu": "Hungarian", "ro": "Romanian",
      "en": "English", "en-us": "English", "en-gb": "English",
    };

    const toLang = (code) => {
      if (!code) return null;
      const key = code.toLowerCase().split(",")[0].trim().replace("_", "-");
      return langMap[key] || langMap[key.split("-")[0]] || null;
    };

    // 1. HTML lang attribute
    const htmlLang = html.match(/<html[^>]+lang=["']([^"']+)["']/i)?.[1] || null;

    // 2. og:locale
    const ogLocale =
      html.match(/<meta[^>]+property=["']og:locale["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:locale["']/i)?.[1] || null;

    // 3. Content-Language response header
    const headerLang = response.headers.get("content-language") || null;

    // 4. hreflang tags (prefer non-English values)
    const hreflangMatches = [...html.matchAll(/hreflang=["']([^"']+)["']/gi)].map(m => m[1]);
    const hreflang = hreflangMatches.find(l => !l.startsWith("en") && l !== "x-default") ||
                     hreflangMatches[0] || null;

    // 5. URL path locale patterns — checked against ORIGINAL URL before any redirect
    // This is intentionally checked on the input URL, not the fetched URL, to handle
    // sites that redirect bots to a different locale (e.g. avogel.ch/de/ → root page)
    const urlLang = url.match(/[\/](de|fr|it|es|nl|pt|pl|sv|da|fi|no|nb|cs|hu|ro|en)(?:[\/\-\_]|$)/i)?.[1] || null;

    // 6. TLD fallback — extract country code TLD from original domain
    const tld = url.match(/\.([a-z]{2})(\/|$)/i)?.[1]?.toLowerCase() || null;
    const tldLang = tld ? tldLangMap[tld] || null : null;

    // 7. Subdomain locale pattern (e.g. de.example.com, fr.brand.com)
    const subdomainLang = url.match(/https?:\/\/(de|fr|it|es|nl|pt|pl|sv|da|fi|no|nb|cs|hu|ro)\./i)?.[1] || null;

    // ── Priority logic ────────────────────────────────────────────────────────
    // htmlLang is trusted ONLY if it is non-English.
    // If htmlLang says "en" (or is missing), we look at all other signals first
    // before falling back to English — this handles sites that set lang="en"
    // incorrectly on non-English pages (common on automotive/brand sites).

    const htmlLangIsEnglish = htmlLang && (htmlLang.toLowerCase().startsWith("en") || htmlLang.toLowerCase() === "en");

    let detectedCode;

    if (htmlLang && !htmlLangIsEnglish) {
      // HTML lang says a specific non-English language — trust it
      detectedCode = htmlLang;
    } else {
      // HTML lang is English or missing — work through all other signals.
      // URL-based signals (path + subdomain) are checked EARLY because they
      // reflect the user's original intent and survive server-side redirects.
      detectedCode =
        urlLang ||         // /de/ /fr/ etc in original URL path — most reliable for multilingual sites
        subdomainLang ||   // de.example.com subdomain pattern
        ogLocale ||        // og:locale meta tag
        headerLang ||      // server Content-Language header
        hreflang ||        // hreflang tags on page
        tldLang ||         // .dk .de .fr TLD
        htmlLang ||        // fall back to htmlLang even if English
        "en";              // last resort default
    }

    const language = toLang(detectedCode) || "English";

    // ── Meta tags extraction ──────────────────────────────────────────────────
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

    return res.status(200).json({
      language,
      detectedLangCode: detectedCode,
      title: ogTitle || title,
      metaDescription: ogDesc || metaDesc,
      siteName: ogSiteName,
      h1,
      signals: { htmlLang, ogLocale, headerLang, hreflang, urlLang, subdomainLang, tldLang, tld },
    });

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
