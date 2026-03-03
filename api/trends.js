// ── Google Trends API ─────────────────────────────────────────────────────────
// Uses Google Trends daily trending searches RSS — reliable, no auth needed

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
    // Google Trends related queries — interest over time for keyword
    const encodedKw = encodeURIComponent(keyword);

    // Try related queries first via the explore API
    const exploreUrl = `https://trends.google.com/trends/api/explore?hl=en-US&tz=-60&req={"comparisonItem":[{"keyword":"${encodedKw}","geo":"${geo}","time":"today 3-m"}],"category":0,"property":""}`;

    const exploreRes = await fetch(exploreUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://trends.google.com/",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (exploreRes.ok) {
      const raw = await exploreRes.text();
      const json = JSON.parse(raw.replace(/^\)\]\}',\n/, ""));
      // Extract related queries from the widgets
      const widgets = json?.widgets || [];
      const relatedWidget = widgets.find(w => w.id === "RELATED_QUERIES");
      if (relatedWidget?.request) {
        const reqToken = relatedWidget.request;
        const relatedUrl = `https://trends.google.com/trends/api/widgetdata/relatedsearches?hl=en-US&tz=-60&req=${encodeURIComponent(JSON.stringify(reqToken))}&token=${encodeURIComponent(relatedWidget.token)}&user_country_code=${geo}`;

        const relatedRes = await fetch(relatedUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://trends.google.com/",
          },
          signal: AbortSignal.timeout(6000),
        });

        if (relatedRes.ok) {
          const relRaw = await relatedRes.text();
          const relJson = JSON.parse(relRaw.replace(/^\)\]\}',\n/, ""));
          const rising = relJson?.default?.rankedList?.[1]?.rankedKeyword || [];
          const top = relJson?.default?.rankedList?.[0]?.rankedKeyword || [];
          const combined = [...rising, ...top]
            .map(k => k.query)
            .filter(Boolean)
            .slice(0, 6);
          if (combined.length > 0) {
            return res.status(200).json({ trends: combined, source: "related_queries", keyword });
          }
        }
      }
    }

    // Fallback — daily trending searches RSS for the geo
    const rssUrl = `https://trends.google.com/trends/trendingsearches/daily/rss?geo=${geo}`;
    const rssRes = await fetch(rssUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(6000),
    });
    const rssText = await rssRes.text();
    const titles = [...rssText.matchAll(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g)]
      .map(m => m[1])
      .filter(t => t !== "Daily Search Trends")
      .slice(0, 6);

    console.log("Trends RSS fallback returned:", titles.length, "results");
    return res.status(200).json({ trends: titles, source: "daily_rss", keyword });

  } catch (err) {
    console.log("Trends error:", err.message);
    return res.status(200).json({ trends: [], error: err.message });
  }
}
