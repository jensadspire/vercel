// ── Trends API — AI-powered search angle suggestions ─────────────────────────
// Uses Claude to generate contextual trending search angles from page metadata

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { keyword, geo = "US", language = "English", title, metaDescription, h1, siteName } = req.body;
  if (!keyword) return res.status(400).json({ error: "keyword is required" });
  console.log("Trends AI request:", { keyword, geo, language });

  const langMap = {
    DE: "German", FR: "French", ES: "Spanish", NL: "Dutch",
    IT: "Italian", PT: "Portuguese", SE: "Swedish", DK: "Danish",
    NO: "Norwegian", PL: "Polish", FI: "Finnish",
  };
  const outputLang = langMap[geo] || language || "English";

  const metaContext = [
    title && `Page title: ${title}`,
    siteName && `Brand: ${siteName}`,
    metaDescription && `Description: ${metaDescription}`,
    h1 && `H1: ${h1}`,
  ].filter(Boolean).join("\n");

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: `You are a search trends expert. Based on the product/category below, generate 6 realistic search queries that people are actively searching for RIGHT NOW related to this product. These should read like real Google searches — specific, varied, and genuinely useful as ad copy angles.

Product/Category: ${keyword}
Market: ${geo}
Language: ${outputLang}
${metaContext ? `\nPage context:\n${metaContext}` : ""}

Rules:
- Write ALL queries in ${outputLang}
- Make them feel like real trending searches, not generic variations
- Include a mix of: style/trend queries, occasion-based, comparison, seasonal, intent-based
- Each query should be 2-5 words max
- Do NOT just append "kaufen/buy/online" to the keyword — be creative
- Return ONLY a JSON array of 6 strings, no other text

Example for "kurze kleider" in German:
["Sommerkleid Trends 2026", "Festival Outfit Damen", "Midi Kleid casual", "Partykleid kurz elegant", "Boho Kleid Sommer", "Kleid Hochzeit Gast"]`
        }],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || "[]";
    const clean = text.replace(/```json|```/g, "").trim();
    const trends = JSON.parse(clean);

    if (Array.isArray(trends) && trends.length > 0) {
      console.log("AI trends generated:", trends.length, "suggestions");
      return res.status(200).json({ trends, source: "ai", keyword });
    }
    throw new Error("Invalid AI response");

  } catch (err) {
    console.log("AI trends error:", err.message);
    // Minimal fallback
    return res.status(200).json({
      trends: [],
      source: "error",
      keyword,
      error: err.message,
    });
  }
}
