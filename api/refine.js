export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key not configured" });

  const { current, instruction, limit, isDesc, language, url } = req.body;
  if (!current || !instruction) return res.status(400).json({ error: "Missing fields" });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: `You are refining a single Google Ads ${isDesc ? "description" : "headline"}.

Current text: "${current}"
Refinement instruction: "${instruction}"
Character limit: ${limit} characters (hard limit — NEVER exceed this)
Language: ${language || "English"} — output MUST be in this language
Page context: ${url || "not provided"}

Return ONLY the refined text — no quotes, no explanation, no punctuation outside the text itself.
The refined text must be ${limit} characters or fewer. Count carefully.`
        }]
      }),
    });

    const data = await response.json();
    const refined = data.content?.find(b => b.type === "text")?.text?.trim() || current;
    // Enforce hard limit server-side as safety net
    const safe = refined.slice(0, limit);
    return res.status(200).json({ refined: safe });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
