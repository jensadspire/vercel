// ── Google Trends API ─────────────────────────────────────────────────────────
// Uses SerpApi-free approach: scrape Google Trends related queries page

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { keyword, geo = "US" } = req.body;
  if (!keyword) return res.status(400).json({ error: "keyword is required" });
  console.log("Trends request:", { keyword, geo });

  try {
    // ── Approach 1: Google Trends autocomplete suggestions ────────────────────
    // This endpoint is more reliable and less rate-limited than explore
    const encodedKw = encodeURIComponent(keyword);
    const autocompleteUrl = `https://trends.google.com/trends/api/autocomplete/${encodedKw}?hl=${geo === "DE" ? "de" : geo === "FR" ? "fr" : geo === "ES" ? "es" : "en"}-${geo}&geo=${geo}&tz=60`;

    const autoRes = await fetch(autocompleteUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://trends.google.com/",
      },
      signal: AbortSignal.timeout(6000),
    });

    if (autoRes.ok) {
      const raw = await autoRes.text();
      const json = JSON.parse(raw.replace(/^\)\]\}',\n/, ""));
      const items = json?.default?.topics || [];
      const trends = items
        .filter(t => t.title && t.type !== "Search term") // filter out exact matches
        .slice(0, 6)
        .map(t => t.title)
        .filter(Boolean);

      if (trends.length > 0) {
        console.log("Trends autocomplete returned:", trends.length, "results:", trends);
        return res.status(200).json({ trends, source: "autocomplete", keyword });
      }
    }

    // ── Approach 2: RSS for supported geos (US, GB, AU, CA) ──────────────────
    const rssGeo = ["US", "GB", "AU", "CA"].includes(geo) ? geo : "US";
    const rssUrl = `https://trends.google.com/trends/trendingsearches/daily/rss?geo=${rssGeo}`;

    const rssRes = await fetch(rssUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(6000),
    });

    if (rssRes.ok) {
      const rssText = await rssRes.text();
      // Filter RSS results to those relevant to the keyword
      const allTitles = [...rssText.matchAll(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g)]
        .map(m => m[1])
        .filter(t => t !== "Daily Search Trends");

      // Try to find relevant ones first, fall back to top results
      const kwWords = keyword.toLowerCase().split(/\s+/);
      const relevant = allTitles.filter(t =>
        kwWords.some(w => t.toLowerCase().includes(w))
      ).slice(0, 4);
      const results = relevant.length >= 2 ? relevant : allTitles.slice(0, 6);

      if (results.length > 0) {
        console.log("Trends RSS returned:", results.length, "results");
        return res.status(200).json({ trends: results, source: "daily_rss", keyword });
      }
    }

    // ── Approach 3: Generate contextual suggestions from keyword ─────────────
    // If all APIs fail, return smart keyword variations as fallback
    const fallbackTrends = generateFallback(keyword, geo);
    console.log("Trends using fallback suggestions:", fallbackTrends);
    return res.status(200).json({ trends: fallbackTrends, source: "fallback", keyword });

  } catch (err) {
    console.log("Trends error:", err.message);
    const fallbackTrends = generateFallback(keyword, geo);
    return res.status(200).json({ trends: fallbackTrends, source: "fallback_error", keyword });
  }
}

function generateFallback(keyword, geo) {
  // Generate contextual search term variations based on the keyword and geo
  const kw = keyword.trim();
  const isGerman = geo === "DE" || geo === "AT" || geo === "CH";
  const isFrench = geo === "FR";
  const isSpanish = geo === "ES";

  if (isGerman) {
    return [
      `${kw} kaufen`,
      `${kw} online`,
      `${kw} Sale`,
      `${kw} günstig`,
      `${kw} Trends 2026`,
      `${kw} Damen`,
    ].slice(0, 5);
  }
  if (isFrench) {
    return [`${kw} acheter`, `${kw} pas cher`, `${kw} tendance 2026`, `${kw} en ligne`, `${kw} soldes`].slice(0, 5);
  }
  if (isSpanish) {
    return [`${kw} comprar`, `${kw} barato`, `${kw} tendencias 2026`, `${kw} online`, `${kw} oferta`].slice(0, 5);
  }
  return [
    `${kw} 2026`,
    `best ${kw}`,
    `${kw} online`,
    `${kw} sale`,
    `${kw} near me`,
  ].slice(0, 5);
}
