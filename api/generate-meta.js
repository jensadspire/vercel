/**
 * /api/generate-meta — Meta Ad Suite Generator
 * Scrapes the URL then generates Facebook/Instagram ad copy via Claude.
 * Reuses the same scrape endpoint the Google flow uses.
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

  const { url, language = "English" } = req.body || {};
  if (!url) return res.status(400).json({ error: "url is required" });

  // ── Step 1: Scrape the URL ────────────────────────────────────────────────
  let pageContent = "";
  try {
    const scrapeRes = await fetch(`${req.headers.origin || "https://" + req.headers.host}/api/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const scrapeData = await scrapeRes.json();
    pageContent = scrapeData.content || scrapeData.text || "";
  } catch (e) {
    pageContent = url; // fallback to URL only
  }

  // ── Step 2: Generate Meta copy via Claude ─────────────────────────────────
  const prompt = `You are an expert Meta (Facebook & Instagram) ads copywriter.

Analyse this product/service page and write scroll-stopping Meta ad copy in ${language}.

Page URL: ${url}
Page content:
${pageContent.slice(0, 3000)}

Write Meta ad copy that interrupts the scroll and drives action. Unlike Google Search ads which answer intent, Meta ads must CREATE desire.

Return ONLY valid JSON — no markdown, no preamble:
{
  "primaryTexts": [
    "Hook-led primary text variant 1 (80-125 chars, opens with a scroll-stopping hook)",
    "Hook-led primary text variant 2 (different angle — pain point, social proof, or curiosity)",
    "Hook-led primary text variant 3 (offer or urgency angle)"
  ],
  "headlines": [
    "Headline 1 (max 40 chars, benefit-led)",
    "Headline 2 (max 40 chars, different benefit)",
    "Headline 3 (max 40 chars, CTA or offer)"
  ],
  "descriptions": [
    "Link description 1 (max 30 chars)",
    "Link description 2 (max 30 chars)"
  ],
  "imagePrompt": "Detailed DALL-E prompt for a 1:1 Meta ad image — photorealistic, clean composition, no text overlays, suitable for Facebook/Instagram feed"
}

Rules:
- Write in ${language}
- Primary text must open with a hook — a question, bold claim, or pattern interrupt
- Never start with the brand name
- Headlines must fit in 40 characters exactly
- Descriptions must fit in 30 characters exactly`;

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
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const claudeData = await claudeRes.json();
    const raw = claudeData.content?.[0]?.text || "";
    const clean = raw.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(clean);
  } catch (e) {
    return res.status(500).json({ error: "Copy generation failed", detail: e.message });
  }

  // ── Step 3: Generate image via DALL-E ─────────────────────────────────────
  let imageUrl = null;
  const dalleKey = process.env.OPENAI_API_KEY;
  if (dalleKey && parsed.imagePrompt) {
    try {
      const imgRes = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${dalleKey}`,
        },
        body: JSON.stringify({
          model: "dall-e-3",
          prompt: parsed.imagePrompt,
          n: 1,
          size: "1024x1024",
          quality: "standard",
        }),
      });
      const imgData = await imgRes.json();
      imageUrl = imgData.data?.[0]?.url || null;

      // ── Upload to Vercel Blob for persistence (DALL-E URLs expire after ~2h) ──
      if (imageUrl && process.env.BLOB_READ_WRITE_TOKEN) {
        try {
          const { put } = await import("@vercel/blob");
          // Fetch the DALL-E image
          const imgFetch = await fetch(imageUrl);
          const imgBuffer = await imgFetch.arrayBuffer();
          const filename = `meta-ad-${Date.now()}.png`;
          const blob = await put(filename, Buffer.from(imgBuffer), {
            access: "public",
            contentType: "image/png",
            token: process.env.BLOB_READ_WRITE_TOKEN,
          });
          imageUrl = blob.url; // replace expiring URL with permanent Vercel Blob URL
        } catch (e) {
          console.warn("Vercel Blob upload failed, using DALL-E URL:", e.message);
          // imageUrl stays as the DALL-E URL — graceful fallback
        }
      }
    } catch {}
  }

  return res.json({
    primaryTexts: parsed.primaryTexts || [],
    headlines: (parsed.headlines || []).map(h => h.slice(0, 40)),
    descriptions: (parsed.descriptions || []).map(d => d.slice(0, 30)),
    imageUrl,
    imagePrompt: parsed.imagePrompt,
  });
}
