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
    //
    // Two forms to handle:
    //   (1) Raw JSON in <script>: "image":"https://..."
    //   (2) JSON-embedded-in-JSON (Next.js __NEXT_DATA__, similar SSR patterns):
    //       \"image\":\"https://...\"
    //   Many modern e-commerce stacks (Next.js, Nuxt, SvelteKit with hydration)
    //   serialize state as a JSON string inside another JSON wrapper, so the
    //   inner quotes get backslash-escaped. We handle (2) by running all three
    //   patterns against an unescape-normalized copy of the HTML in addition
    //   to the raw HTML. URLs are deduplicated later, so this is safe.
    const htmlUnescaped = html.replace(/\\"/g, '"').replace(/\\\//g, '/');

    // Pattern A: direct string under common keys → "image":"https://..."
    const patternA = /"(?:image|img|photo|thumbnail|src|hoverImage|productImage|primaryImage)":\s*"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi;
    const jsonImgMatches = [
      ...html.matchAll(patternA),
      ...htmlUnescaped.matchAll(patternA),
    ];

    // Pattern B: array of URL strings under plural/collection keys.
    // Catches CommerceTools-style structures like:
    //   "images":{"value":["https://...jpg","https://...png"]}
    //   "images":["https://...jpg","https://...png"]
    //   "galleryImages":[{"url":"https://..."}, ...]   ← handled below in Pattern C
    // The regex finds the key, then captures everything up to the closing bracket;
    // we extract individual URLs from that block in a second pass.
    const patternB = /"(?:images|productImages|galleryImages|media|mediaGallery|productMedia|productGallery)"\s*:\s*(?:\{\s*"value"\s*:\s*)?\[([^\]]{0,4000})\]/gi;
    const jsonImgArrayBlocks = [
      ...html.matchAll(patternB),
      ...htmlUnescaped.matchAll(patternB),
    ];
    const jsonImgArrayMatches = [];
    for (const block of jsonImgArrayBlocks) {
      const urls = [...block[1].matchAll(/"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi)];
      for (const u of urls) jsonImgArrayMatches.push(u);
    }

    // Pattern C: array of objects with url property, common in some headless setups.
    //   "image":[{"url":"https://..."},{"url":"https://..."}]
    const patternC = /"(?:image|images|productImage|productImages|media|gallery)"\s*:\s*\[(?:\s*\{\s*"(?:url|src|href)"\s*:\s*"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"[^}]*\}\s*,?\s*){1,20}\]/gi;
    const jsonImgObjectMatches = [
      ...html.matchAll(patternC),
      ...htmlUnescaped.matchAll(patternC),
    ];
    // The outer match captures the entire array; pull individual URLs out of each match's full text.
    const jsonImgObjectUrls = [];
    for (const m of jsonImgObjectMatches) {
      const urls = [...m[0].matchAll(/"(?:url|src|href)"\s*:\s*"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi)];
      for (const u of urls) jsonImgObjectUrls.push(u);
    }
    const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1];

    // ── JSON-LD Product.image extraction ────────────────────────────────────
    // Schema.org Product schemas often declare canonical product images
    // independent of og:image. When present, treat them like og:image —
    // a strong, site-declared signal. Handle both single string and array.
    let jsonLdImages = [];
    const jsonLdMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const m of jsonLdMatches) {
      try {
        const parsed = JSON.parse(m[1].trim());
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (item && item['@type'] === 'Product' && item.image) {
            const imgs = Array.isArray(item.image) ? item.image : [item.image];
            for (const img of imgs) {
              const url = typeof img === 'object' ? (img.url || img['@id']) : img;
              if (url && typeof url === 'string') jsonLdImages.push(url);
            }
          }
        }
        if (jsonLdImages.length > 0) break;
      } catch (_) {}
    }

    // ── Product-slug token extraction ───────────────────────────────────────
    // Powers the new positive signal: images whose filename contains tokens
    // from the page's product slug get boosted. The intuition: a Plantorama
    // parasol page's product image usually has "parasol" or "lima" in its
    // filename; an unrelated promo spot (like "forside-cta-spot-espresso-house")
    // doesn't.
    //
    // We extract TWO kinds of tokens:
    //   1. Word tokens (e.g. "lima", "haengeparasol", "loungesaet")
    //   2. SKU-style codes (e.g. "pg-7587-0255-670", "7260-9871500") —
    //      important because CommerceTools-style sites name image files
    //      after the SKU rather than the product name.
    const extractProductSlugTokens = (pageUrl) => {
      try {
        const path = new URL(pageUrl).pathname.toLowerCase();
        const segments = path.split('/').filter(Boolean);

        const wordTokens = [];
        const skuTokens = [];

        // Look at all segments, not just the last — SKUs can appear mid-path.
        for (const segment of segments) {
          // Detect SKU-style codes: 2+ dash-separated parts where at least
          // one part is purely numeric and 3+ chars long. Catches:
          //   pg-7587-0255-670, 7260-9871500, sku-12345-789
          // Avoids matching simple two-word slugs like "linen-dress".
          const skuMatch = segment.match(/(?:^|[^a-z0-9])([a-z]{1,4}-)?(\d{3,}-\d{3,}(?:-\d{2,}){0,3})/i);
          if (skuMatch) {
            const code = (skuMatch[1] || '') + skuMatch[2];
            // Store both the full code and the dash-separated parts —
            // image filenames sometimes use uppercase prefix (PG-) and
            // sometimes drop it, so we want flexibility.
            skuTokens.push(code.toLowerCase());
            // Also store the numeric core, which is highly distinctive.
            skuTokens.push(skuMatch[2].toLowerCase());
          }

          // Word tokens — same logic as before.
          const tokens = segment
            .split(/[-_]/)
            .filter(t => t.length >= 3 && !/^\d+$/.test(t) && !/^\d+[a-z]?$/i.test(t));
          for (const t of tokens) {
            if (!wordTokens.includes(t)) wordTokens.push(t);
          }
        }

        return { wordTokens, skuTokens };
      } catch (_) {
        return { wordTokens: [], skuTokens: [] };
      }
    };
    const productSlugTokens = extractProductSlugTokens(url);

    // ── Hard-exclude filter ────────────────────────────────────────────────
    // Categories that are NEVER a product image. These get dropped from the
    // candidate pool before scoring. og:image and JSON-LD Product.image
    // bypass this — those are the site's own canonical declaration.
    // Note: pattern strings include separators like '-' and '/' where useful
    // to avoid false-positive substring matches (e.g. 'co2-' rather than
    // 'co2' which could match legitimate product codes).
    const HARD_EXCLUDE_PATTERNS = [
      // Payment provider logos
      'visa', 'mastercard', 'klarna', 'paypal', 'applepay', 'apple-pay',
      'mobilepay', 'mobile-pay', 'amex', 'american-express',
      // Trust / approval badges
      'trustpilot', 'emaerk', 'e-maerket', 'trygehandel', 'tryg-e-handel',
      '/trust/', '/seal/', '/award/', '/rating/', 'trustbadge',
      // Sustainability / certification icons
      'co2-', 'klima-', 'eco-label', 'certified', '-iso-',
      // Pixels / blanks
      '1x1', '/pixel.', 'blank.gif', 'blank.png', 'spacer.gif',
      'transparent.gif', 'transparent.png',
      // Explicit UX / nav / sprite assets
      'sprite', '/arrow-', '/chevron-', 'nav-', '/payment-', 'shipping-icon',
      '/flag-', '/flags/',
    ];

    const isHardExcluded = (src) => {
      if (!src) return true;
      const s = src.toLowerCase();
      // Exclude all .gif (banners/animations, virtually never product photos)
      if (s.endsWith('.gif') || s.includes('.gif?') || s.includes('.gif#')) return true;
      // Exclude .ico (favicons; would be disastrous as an ad creative)
      if (s.endsWith('.ico') || s.includes('.ico?')) return true;
      // Match any of the explicit patterns
      return HARD_EXCLUDE_PATTERNS.some(pattern => s.includes(pattern));
    };

    // Score each image — product gallery thumbnails get priority
    const scoreImage = (tag, src) => {
      let score = 0;
      const t = tag.toLowerCase();
      const s = (src || '').toLowerCase();
      const filename = s.split('/').pop() || '';

      // ── Product gallery signals ──────────────────────────────────────────
      if (t.includes('data-index') || t.includes('data-thumb') || t.includes('gallery')) score += 5;
      if (t.includes('product') || s.includes('product')) score += 4;
      if (t.includes('data-zoom') || t.includes('data-large') || t.includes('data-full')) score += 3;
      if (t.includes('swiper') || t.includes('carousel') || t.includes('slider')) score += 3;
      if (s.includes('/products/') || s.includes('/shop/files/') || s.includes('/shop/product')) score += 3;

      // ── Product-slug matching (new) ──────────────────────────────────────
      // Boost images whose filename echoes the page URL's product slug. This
      // is the strongest "this is THE product image" signal we can derive
      // cheaply — it separates the right product image from unrelated
      // graphics that happen to live on the page.
      //
      // Two kinds of matches:
      //   - Word tokens (lima, parasol, loungesaet) at +3 each, capped at +9.
      //     Loose: catches partial filename echoes.
      //   - SKU tokens (pg-7587-0255-670, 7260-9871500) at +12 each.
      //     Strict: SKU presence is a near-certain "THIS is the product image"
      //     signal. CommerceTools / Centra / Magento sites often name image
      //     files after the SKU rather than the product name, which is why
      //     this is a separate, heavier-weighted signal.
      if (productSlugTokens.wordTokens.length > 0) {
        const matchedWords = productSlugTokens.wordTokens.filter(t => filename.includes(t));
        if (matchedWords.length > 0) {
          score += Math.min(matchedWords.length * 3, 9);
        }
      }
      if (productSlugTokens.skuTokens.length > 0) {
        const matchedSku = productSlugTokens.skuTokens.some(t => filename.includes(t));
        if (matchedSku) {
          score += 12;
        }
      }

      // ── Resolution boosts ────────────────────────────────────────────────
      const wMatch = s.match(/[?&]width=(\d+)/);
      if (wMatch) {
        const w = parseInt(wMatch[1]);
        if (w >= 1800) score += 5;
        else if (w >= 900) score += 3;
        else if (w <= 520) score -= 3;
      }
      if (/1800x1800|2048x2048|1600x1600/.test(s)) score += 4;
      if (/cdn\/shop\/files\//.test(s) && !/width=520|width=300/.test(s)) score += 2;
      if (s.includes('packshot') || s.includes('product-image') || s.includes('produktbild')) score += 4;
      if (s.includes('media.plantorama') || s.includes('cdn.') && s.includes('packshot')) score += 4;
      const widthMatch = t.match(/width=["'](\d+)["']/);
      if (widthMatch && parseInt(widthMatch[1]) > 400) score += 2;

      // ── Modern CDN / responsive-image boosts (new, light touch) ──────────
      // Sites using these CDNs or serving responsive images tend to have
      // better-curated product imagery overall. Capped contribution.
      let cdnBoost = 0;
      if (s.includes('cloudinary.com')) cdnBoost += 2;
      if (s.includes('imgix.net')) cdnBoost += 2;
      if (s.includes('contentful.com')) cdnBoost += 2;
      if (s.includes('akamaized.net')) cdnBoost += 2;
      score += Math.min(cdnBoost, 4);

      // ── Penalise non-product images (existing tokens, harmonised at -5) ──
      if (s.includes('icon') || s.includes('logo') || s.includes('banner') || s.includes('badge')) score -= 5;
      if (s.includes('avatar') || s.includes('author') || s.includes('pixel')) score -= 5;
      if (s.includes('placeholder') || s.includes('blank')) score -= 10;

      // ── Additional noise tokens (new, harmonised at -5) ──────────────────
      // Banner spots, promo CTAs, off-page content (e.g. "forside-cta-spot"
      // appearing on a product page is content from a different page).
      if (s.includes('cta') || s.includes('spot-') || s.includes('-spot')) score -= 5;
      if (s.includes('forside') || s.includes('frontpage') || s.includes('/home-')) score -= 5;
      if (s.includes('wysiwyg') || s.includes('/cms/')) score -= 5;

      // ── Promotional / discount / navigation penalties ────────────────────
      if (s.includes('procent') || s.includes('percent') || s.includes('rabat') || s.includes('discount')) score -= 10;
      if (s.includes('navigation') || s.includes('nav-') || s.includes('noimageindex')) score -= 8;
      if (s.includes('rebate') || s.includes('offer') || s.includes('campaign') || s.includes('promo')) score -= 6;

      // ── Landscape-banner dimension penalty (existing, unchanged) ─────────
      const dimsMatch = s.match(/(\d{3,4})x(\d{3,4})/);
      if (dimsMatch) {
        const w = parseInt(dimsMatch[1]), h = parseInt(dimsMatch[2]);
        if (w > h * 1.5) score -= 4; // wide landscape = likely banner
        if (w > 2000 && h < 800) score -= 6; // very wide banner
      }

      // ── Small-dimension penalty (new — catches 99x32, 180x180, etc.) ─────
      // The landscape check above only catches 3-4 digit dims, so very small
      // images like 99x32 (Abena banner) and small squares like 180x180
      // (Plantorama promo spot) escaped entirely. This catches them.
      const smallDimsMatch = filename.match(/(\d{2,4})x(\d{2,4})/);
      if (smallDimsMatch) {
        const w = parseInt(smallDimsMatch[1]), h = parseInt(smallDimsMatch[2]);
        if (w < 200 && h < 200) score -= 6;          // small both ways
        else if (w < 100 || h < 100) score -= 6;     // very small one side
      }

      // ── Hex colour codes in filename (promo graphics) ────────────────────
      if (/[0-9a-f]{6}/i.test(filename)) score -= 3;

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
    const jsonArrayImgs = jsonImgArrayMatches.map(m => ({ tag: '', src: m[1] }));
    const jsonObjectImgs = jsonImgObjectUrls.map(m => ({ tag: '', src: m[1] }));
    const srcsetImgsList = srcsetUrls.map(src => ({ tag: '', src }));

    // Apply hard-exclude filter, then score the survivors.
    const scoredImages = [...allImgTags, ...lazyImgs, ...jsonImgs, ...jsonArrayImgs, ...jsonObjectImgs, ...srcsetImgsList]
      .filter(({ src }) => src && !isHardExcluded(src))
      .map(({ tag, src }) => ({ src, score: scoreImage(tag, src) }));

    const normaliseUrl = (src) => {
      if (!src) return null;
      if (src.startsWith('http')) return src;
      if (src.startsWith('//')) return 'https:' + src;
      if (src.startsWith('/')) return baseUrl + src;
      return null;
    };

    // Sort by score, put site-declared canonical images first (og:image and
    // JSON-LD Product.image bypass the hard-exclude filter — the site itself
    // declared them as canonical, so we trust that).
    scoredImages.sort((a, b) => b.score - a.score);

    const rawImages = [
      ogImage,
      ...jsonLdImages,
      ...scoredImages.map(({ src }) => src),
    ].filter(Boolean)
     .map(normaliseUrl)
     .filter(src => src && !src.includes('data:') && !src.includes('.svg') && !src.includes('placeholder'));

    // Deduplicate preserving order
    result.images = [...new Set(rawImages)].slice(0, 20);

    // ── Price + currency ──────────────────────────────────────────────────────
    // Prefer structured data bound to the product so the price stays tied to the
    // hero product and carries its real currency: JSON-LD Offer first (price +
    // priceCurrency together), then product/og price meta. A loose page scan is
    // the last resort and yields NO currency, so the UI suppresses it (better no
    // price than a wrong one). Category pages have 0 or many Product nodes, so
    // they produce no price here — which is the intended behaviour.
    let price = null, priceCurrency = null;
    const toArr = (x) => Array.isArray(x) ? x : (x == null ? [] : [x]);

    // 1. JSON-LD: only trust a price when there is exactly ONE Product node.
    const ldProducts = [];
    for (const ld of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const parsed = JSON.parse(ld[1].trim());
        const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (stack.length) {
          const node = stack.shift();
          if (!node || typeof node !== 'object') continue;
          if (node['@graph']) stack.push(...toArr(node['@graph']));
          if (toArr(node['@type']).includes('Product')) ldProducts.push(node);
        }
      } catch (_) {}
    }
    if (ldProducts.length === 1) {
      for (const off of toArr(ldProducts[0].offers)) {
        if (off && typeof off === 'object' && off.priceCurrency && (off.price != null || off.lowPrice != null)) {
          const amt = String(off.price != null ? off.price : off.lowPrice).trim();
          if (parseFloat(amt.replace(',', '.')) > 0) { price = amt; priceCurrency = String(off.priceCurrency).trim().toUpperCase(); }
          break;
        }
      }
    }

    // 2. OpenGraph / product price meta (amount + currency paired).
    if (!price) {
      const amt = html.match(/<meta[^>]+property=["'](?:product:price:amount|og:price:amount)["'][^>]+content=["']([^"']+)["']/i);
      if (amt && parseFloat(amt[1].replace(',', '.')) > 0) {
        price = amt[1].trim();
        const cur = html.match(/<meta[^>]+property=["'](?:product:price:currency|og:price:currency)["'][^>]+content=["']([^"']+)["']/i);
        if (cur) priceCurrency = cur[1].trim().toUpperCase();
      }
    }

    // 3. Last resort: a loose number with NO reliable currency (UI suppresses it).
    if (!price) {
      for (const pat of [/class=["'][^"']*price[^"']*["'][^>]*>[^<]*?([\d]+[.,]\d{2})/i, /"price"\s*:\s*"?([\d]+[.,]\d{0,2})"?/i]) {
        const mm = html.match(pat);
        if (mm && mm[1] && parseFloat(mm[1].replace(',', '.')) > 0) { price = mm[1].trim(); break; }
      }
    }

    if (price) result.price = price;
    if (priceCurrency) result.priceCurrency = priceCurrency;

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
          // Validate with parallel HEAD requests (much faster than sequential)
          const headChecks = await Promise.allSettled(
            galleryImgs.map(imgUrl =>
              fetch(imgUrl, { method: 'HEAD', signal: AbortSignal.timeout(1500) })
                .then(r => r.ok ? imgUrl : null)
                .catch(() => null)
            )
          );
          const validImgs = headChecks
            .map(r => r.status === 'fulfilled' ? r.value : null)
            .filter(Boolean)
            .slice(0, 12);
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
