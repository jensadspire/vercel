// ── Image Generation API — Claude Vision + DALL-E 3 ──────────────────────────

export const config = {
  api: { bodyParser: { sizeLimit: "10mb" } }, // increase limit for base64 images
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { imageBase64, mediaType, siteName, title, h1, language, userGuidance, creativeStyle } = req.body;

  if (!imageBase64) return res.status(400).json({ error: "No image provided" });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  console.log("image-gen: keys present:", { anthropic: !!anthropicKey, openai: !!openaiKey });

  if (!anthropicKey || !openaiKey) return res.status(500).json({ error: "API keys not configured" });

  try {
    // ── Step 1: Claude Vision analyses the uploaded image ──────────────────
    console.log("image-gen: starting vision analysis, image size:", imageBase64.length);
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
              text: `Analyse this brand/product image and extract key visual characteristics for ad generation.

Brand context:
${siteName ? `Brand: ${siteName}` : ""}
${title ? `Page title: ${title}` : ""}
${h1 ? `H1: ${h1}` : ""}
${creativeStyle === "match" ? "IMPORTANT: The user wants to MATCH this exact visual style. Your dallePrompt must strictly replicate the background, lighting and composition of this image." : ""}
${creativeStyle === "studio" ? "IMPORTANT: Generate a clean studio-style DALL-E prompt with neutral background, professional lighting, product as hero." : ""}
${creativeStyle === "lifestyle" ? "IMPORTANT: Generate a lifestyle DALL-E prompt showing the product in a real-world setting with natural environment." : ""}
${creativeStyle === "match" ? 
  "Creative style: STRICTLY match the visual style of the uploaded image. If the image shows clean studio photography with neutral background, replicate that exactly. Do not add lifestyle elements, outdoor settings or people unless they are in the original image." :
  creativeStyle === "studio" ? "Creative style: Clean professional studio photography. Neutral or white background. Product is the hero. No outdoor or lifestyle elements." :
  creativeStyle === "lifestyle" ? "Creative style: Lifestyle photography showing the product in real-life situations and environments. Natural settings, authentic mood." :
  creativeStyle ? `Creative style: ${creativeStyle}` : ""}
${userGuidance ? `Additional guidance: ${userGuidance}` : ""}

Return ONLY a JSON object, no prose, no markdown:
{
  "style": "photographic/illustrated/minimal/bold/lifestyle",
  "mood": "energetic/calm/luxurious/playful/professional",
  "colorPalette": "describe dominant colors in 1 sentence",
  "subject": "main subject/product in 1 sentence",
  "dallePrompt": "A detailed DALL-E 3 prompt (80-120 words) that recreates this brand visual style for a Google PMax ad. Describe: visual style, color palette, mood, lighting, composition. Do NOT include any text, logos or words in the image. End with: high quality commercial photography, professional advertising image, no text overlay."
}`,
            },
          ],
        }],
      }),
    });

    const visionData = await visionRes.json();
    console.log("image-gen: vision response status:", visionRes.status);

    if (visionData.error) {
      console.log("image-gen: vision error:", visionData.error);
      return res.status(500).json({ error: "Vision analysis failed: " + visionData.error.message });
    }

    const visionText = visionData.content?.[0]?.text || "{}";
    const visionClean = visionText.replace(/```json|```/g, "").trim();
    let analysis = {};
    try {
      analysis = JSON.parse(visionClean);
    } catch (e) {
      console.log("image-gen: vision parse error:", e.message, "raw:", visionClean.slice(0, 200));
      analysis = { dallePrompt: "Professional product advertising image, clean studio background, high quality commercial photography, no text overlay." };
    }
    console.log("image-gen: vision analysis:", analysis.style, analysis.mood);

    // ── Step 2: Build the generation prompt (Imagen runs client-side) ─────
    // DALL-E 3 was retired (May 2026). The PMax own-assets engine now
    // generates via /api/imagen (Vertex Imagen 3) on the client, which
    // persists to Blob and can use the uploaded image as a subject
    // reference. This endpoint now returns the analysis + a clean prompt.
    const basePrompt = analysis.dallePrompt ||
      "Professional product advertising image, clean background, high quality commercial photography, no text overlay.";

    console.log("image-gen: analysis complete, returning prompt for client-side Imagen");

    return res.status(200).json({
      prompt: basePrompt,
      analysis: {
        style: analysis.style,
        mood: analysis.mood,
        colorPalette: analysis.colorPalette,
        subject: analysis.subject,
      },
    });

  } catch (err) {
    console.error("image-gen: fatal error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
