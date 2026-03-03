// ── Google Trends API ─────────────────────────────────────────────────────────
// Uses RSS for supported geos, smart contextual fallback for others

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { keyword, geo = "US" } = req.body;
  if (!keyword) return res.status(400).json({ error: "keyword is required" });
  console.log("Trends request:", { keyword, geo });

  // ── RSS only works reliably for these geos ────────────────────────────────
  const rssGeo = ["US", "GB", "AU", "CA"].includes(geo) ? geo : null;

  if (rssGeo) {
    try {
      const rssUrl = `https://trends.google.com/trends/trendingsearches/daily/rss?geo=${rssGeo}`;
      const rssRes = await fetch(rssUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(6000),
      });
      if (rssRes.ok) {
        const rssText = await rssRes.text();
        const allTitles = [...rssText.matchAll(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g)]
          .map(m => m[1])
          .filter(t => t !== "Daily Search Trends");
        const kwWords = keyword.toLowerCase().split(/\s+/);
        const relevant = allTitles.filter(t =>
          kwWords.some(w => t.toLowerCase().includes(w))
        ).slice(0, 4);
        const results = relevant.length >= 2 ? relevant : allTitles.slice(0, 5);
        if (results.length > 0) {
          console.log("Trends RSS returned:", results.length, "results");
          return res.status(200).json({ trends: results, source: "daily_rss", keyword });
        }
      }
    } catch (_) {}
  }

  // ── Contextual fallback for all other geos (DE, FR, ES, NL etc) ───────────
  const fallback = generateFallback(keyword, geo);
  console.log("Trends contextual fallback:", fallback);
  return res.status(200).json({ trends: fallback, source: "fallback", keyword });
}

function generateFallback(keyword, geo) {
  const kw = keyword.trim();
  if (["DE", "AT", "CH"].includes(geo)) {
    return [`${kw} kaufen`, `${kw} online Shop`, `${kw} Sale 2026`, `${kw} günstig`, `${kw} Trends`];
  }
  if (geo === "FR") {
    return [`${kw} acheter`, `${kw} en ligne`, `${kw} soldes 2026`, `${kw} tendance`, `${kw} pas cher`];
  }
  if (geo === "ES") {
    return [`${kw} comprar`, `${kw} online`, `${kw} oferta 2026`, `${kw} tendencias`, `${kw} barato`];
  }
  if (geo === "NL") {
    return [`${kw} kopen`, `${kw} online`, `${kw} sale 2026`, `${kw} goedkoop`, `${kw} trends`];
  }
  if (geo === "IT") {
    return [`${kw} comprare`, `${kw} online`, `${kw} saldi 2026`, `${kw} tendenze`, `${kw} economico`];
  }
  if (geo === "SE") {
    return [`${kw} köpa`, `${kw} online`, `${kw} rea 2026`, `${kw} trender`, `${kw} billig`];
  }
  if (geo === "DK") {
    return [`${kw} købe`, `${kw} online`, `${kw} tilbud 2026`, `${kw} trends`, `${kw} billig`];
  }
  return [`best ${kw}`, `${kw} 2026`, `${kw} online`, `${kw} sale`, `${kw} near me`];
}
