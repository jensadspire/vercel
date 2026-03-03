// ── Google Trends API ─────────────────────────────────────────────────────────
// Fetches trending topics related to a keyword using Google Trends RSS feed
// No API key required — uses the public RSS endpoint

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { keyword, geo = "US" } = req.body;
  if (!keyword) return res.status(400).json({ error: "keyword is required" });

  try {
    // Google Trends related queries via RSS — public, no auth needed
    const encodedKw = encodeURIComponent(keyword);
    const trendsUrl = `https://trends.google.com/trends/trendingsearches/daily/rss?geo=${geo}`;
    const relatedUrl = `https://trends.google.com/trends/explore/RELATED_QUERIES?hl=en-US&tz=-60&req={"comparisonItem":[{"keyword":"${encodedKw}","geo":"${geo}","time":"today 3-m"}],"category":0,"property":""}`;

    // Use the interest over time + related topics approach via the suggestions API
    const suggestUrl = `https://trends.google.com/trends/api/autocomplete/${encodedKw}?hl=en-US&tz=60`;

    const response = await fetch(suggestUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://trends.google.com/",
      },
      signal: AbortSignal.timeout(6000),
    });

    const raw = await response.text();
    // Google Trends prepends ")]}',\n" to JSON responses as XSSI protection
    const json = JSON.parse(raw.replace(/^\)\]\}',\n/, ""));
    const suggestions = json?.default?.topics || json?.default?.queries || [];

    const trends = suggestions
      .slice(0, 6)
      .map(s => s.title || s.query)
      .filter(Boolean);

    if (trends.length > 0) {
      return res.status(200).json({ trends, source: "suggestions", keyword });
    }

    // Fallback — use daily trending searches RSS for the geo
    const rssRes = await fetch(trendsUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(6000),
    });
    const rssText = await rssRes.text();
    const titles = [...rssText.matchAll(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g)]
      .map(m => m[1])
      .filter(t => t !== "Daily Search Trends")
      .slice(0, 6);

    return res.status(200).json({ trends: titles, source: "daily_rss", keyword });

  } catch (err) {
    console.log("Trends error:", err.message);
    return res.status(200).json({ trends: [], error: err.message });
  }
}
