/**
 * /api/generate-tiktok — TikTok Ad Suite Generator
 * Generates: hook line, primary text, CTA, hashtags, video storyboard
 * Uses scraped URL content + Claude for copy, Runway for video
 */

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key not configured" });

  const { url, language = "English", audienceBrief = null, pageContent = "", pageMeta = {} } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  // ── Scrape if no content provided ────────────────────────────────────────────
  let content = pageContent;
  if (!content) {
    try {
      const scrapeRes = await fetch(`${req.headers.origin || "https://" + req.headers.host}/api/scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const scrapeData = await scrapeRes.json();
      content = scrapeData.content || scrapeData.text || "";
    } catch (_) {}
  }

  // ── Brand name from URL ───────────────────────────────────────────────────────
  let brand = "";
  try {
    const domain = new URL(url).hostname.replace("www.", "");
    brand = domain.split(".")[0];
    brand = brand.charAt(0).toUpperCase() + brand.slice(1);
  } catch (_) {}

  // ── Build prompt ──────────────────────────────────────────────────────────────
  const prompt = `You are an expert TikTok ad copywriter. Write a complete TikTok in-feed ad for this product/brand.

URL: ${url}
Brand: ${brand}
Page content: ${content.slice(0, 1000)}
Language: ${language}

${audienceBrief ? `Audience Brief:
- Name: ${audienceBrief.audienceName || ""}
- Messaging tone: ${audienceBrief.messagingTone || ""}
- Copy angles: ${(audienceBrief.copySignals || []).join(", ")}
- Pain points: ${(audienceBrief.painPoints || []).join(", ")}
Use these signals to sharpen the copy.` : ""}

TikTok ad rules:
- Hook line: First 3 seconds — must stop the scroll. Max 8 words. Bold, direct, curiosity-driven or surprising.
- Primary text: 1-2 punchy sentences. Conversational, energetic TikTok voice. Max 100 chars total.
- CTA: Short action phrase. Max 4 words. (e.g. "Shop now", "Try it today", "Link in bio")
- Hashtags: 4-6 relevant hashtags. Mix broad (#fashion) and niche (#danishdesign). No spaces.
- Video storyboard: 4 scenes describing what happens in the video (each scene 1-2 sentences). 
  Scene 1: Hook visual (0-3 sec) — what grabs attention immediately
  Scene 2: Problem or desire (3-8 sec) — relatable moment
  Scene 3: Product reveal (8-18 sec) — product shown in use, clearly visible
  Scene 4: CTA close (18-25 sec) — strong ending with call to action
- Write in ${language}
- Never start with the brand name
- Sound native to TikTok — not like a TV commercial

Return ONLY valid JSON:
{
  "hookLine": "Stop-scroll opening line (max 8 words)",
  "primaryText": "Main ad copy (max 100 chars)",
  "cta": "Call to action (max 4 words)",
  "hashtags": ["#tag1", "#tag2", "#tag3", "#tag4", "#tag5"],
  "storyboard": [
    { "scene": 1, "timing": "0-3s", "title": "Hook", "description": "Visual description of opening" },
    { "scene": 2, "timing": "3-8s", "title": "Problem/Desire", "description": "Relatable moment shown" },
    { "scene": 3, "timing": "8-18s", "title": "Product Reveal", "description": "Product in use, benefit shown" },
    { "scene": 4, "timing": "18-25s", "title": "CTA Close", "description": "Strong ending with action" }
  ],
  "videoPrompt": "Single detailed prompt for Runway video generation — 9:16 vertical format, describe the full scene, lighting, mood, movement. Product must be clearly visible."
}`;

  // ── Call Claude ───────────────────────────────────────────────────────────────
  let parsed;
  try {
    const claudeRes = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const claudeData = await claudeRes.json();
    const raw = claudeData.content?.[0]?.text || "";
    if (!raw) {
      const errMsg = claudeData.error?.message || JSON.stringify(claudeData);
      return res.status(500).json({ error: "TikTok copy generation failed", detail: errMsg });
    }
    const clean = raw.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(clean);
  } catch (e) {
    return res.status(500).json({ error: "TikTok copy generation failed", detail: e.message });
  }

  return res.status(200).json({
    hookLine: parsed.hookLine || "",
    primaryText: parsed.primaryText || "",
    cta: parsed.cta || "",
    hashtags: parsed.hashtags || [],
    storyboard: parsed.storyboard || [],
    videoPrompt: parsed.videoPrompt || "",
    brand,
  });
}
