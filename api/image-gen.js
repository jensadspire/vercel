// ── Image Generation API — Claude Vision + DALL-E 3 ──────────────────────────
// Flow: uploaded image → Claude analyses brand/style → DALL-E 3 generates per format

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { imageBase64, mediaType, siteName, title, h1, language, userGuidance } = req.body;

  if (!imageBase64) return res.status(400).json({ error: "No image provided" });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey || !openaiKey) return res.status(500).json({ error: "API keys not configured" });

  try {
    // ── Step 1: Claude Vision analyses the uploaded image ──────────────────
    const visionRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType || "image/jpeg", data: imageBase64 },
            },
            {
              type: "text",
              text: `Analyse this brand/product image and extract key visual characteristics for use in ad image generation.

Brand context:
${siteName ? `Brand: ${siteName}` : ""}
${title ? `Page title: ${title}` : ""}
${h1 ? `H1: ${h1}` : ""}
${userGuidance ? `User guidance: ${userGuidance}` : ""}

Return ONLY a JSON object with these fields:
{
  "style": "photographic/illustrated/minimal/bold/lifestyle etc",
  "mood": "energetic/calm/luxurious/playful/professional etc",
  "colorPalette": "describe dominant colors in 1 sentence",
  "subject": "main subject/product described in 1 sentence",
  "brandPersonality": "1 sentence describing brand feel",
  "dallePrompt": "A detailed, specific DALL-E 3 prompt (100-150 words) that recreates the style and mood of this brand image for a Google PMax ad. Include: visual style, color palette, mood, composition, lighting. End with: high quality commercial photography, clean background, professional advertising image."
}`,
            },
          ],
        }],
      }),
    });

    const visionData = await visionRes.json();
    const visionText = visionData.content?.[0]?.text || "{}";
    const visionClean = visionText.replace(/```json|```/g, "").trim();
    const analysis = JSON.parse(visionClean);
    console.log("Vision analysis complete:", analysis.style, analysis.mood);

    // ── Step 2: Generate 3 images via DALL-E 3 (one per PMax format) ───────
    const formats = [
      { id: "landscape", label: "Landscape", size: "1792x1024", ratio: "1.91:1", dims: "1200×628px" },
      { id: "square",    label: "Square",    size: "1024x1024", ratio: "1:1",    dims: "1200×1200px" },
      { id: "portrait",  label: "Portrait",  size: "1024x1792", ratio: "4:5",    dims: "960×1200px" },
    ];

    const basePrompt = analysis.dallePrompt || 
      `Professional advertising image in ${analysis.style || "modern"} style. ${analysis.colorPalette || ""}. ${analysis.mood || "professional"} mood. High quality commercial photography, clean background, professional advertising image.`;

    const imageResults = await Promise.all(
      formats.map(async (fmt) => {
        try {
          const dalleRes = await fetch("https://api.openai.com/v1/images/generations", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${openaiKey}`,
            },
            body: JSON.stringify({
              model: "dall-e-3",
              prompt: `${basePrompt} Optimized for ${fmt.ratio} aspect ratio ${fmt.label.toLowerCase()} format Google PMax ad.`,
              size: fmt.size,
              quality: "standard",
              n: 1,
            }),
          });
          const dalleData = await dalleRes.json();
          const imageUrl = dalleData.data?.[0]?.url;
          return { ...fmt, imageUrl, error: imageUrl ? null : "Generation failed" };
        } catch (e) {
          return { ...fmt, imageUrl: null, error: e.message };
        }
      })
    );

    console.log("Images generated:", imageResults.filter(r => r.imageUrl).length, "/ 3");

    return res.status(200).json({
      images: imageResults,
      analysis: {
        style: analysis.style,
        mood: analysis.mood,
        colorPalette: analysis.colorPalette,
        subject: analysis.subject,
      },
    });

  } catch (err) {
    console.error("Image gen error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
