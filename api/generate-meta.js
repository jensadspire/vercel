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

  const { url, language = "English", imageModel = "dalle", isPro = false } = req.body || {};
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

  // ── Gender signal detection ───────────────────────────────────────────────
  const genderSignals = {
    female: ['damen','women','woman','female','femme','donna','mujer','kvinder','dame','ladies','girl','she/her'],
    male:   ['herren','men','man','male','homme','uomo','hombre','herr','mænd','guys','he/him'],
  };
  const textToScan = (url + ' ' + pageContent.slice(0, 500)).toLowerCase();
  const femaleScore = genderSignals.female.filter(w => textToScan.includes(w)).length;
  const maleScore   = genderSignals.male.filter(w => textToScan.includes(w)).length;
  const genderHint  = femaleScore > maleScore ? 'female' : maleScore > femaleScore ? 'male' : null;
  const modelHint   = genderHint === 'female' ? ' Feature a female model if people are shown.'
                    : genderHint === 'male'   ? ' Feature a male model if people are shown.'
                    : '';

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
  "imagePrompt": "Detailed prompt for a 1:1 Meta ad image — photorealistic, clean composition, no text overlays, no logos.${modelHint} Show the product in a lifestyle setting relevant to the brand." overlays, suitable for Facebook/Instagram feed"
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

  // ── Step 3: Generate image variations in parallel ───────────────────────────
  let imageUrl = null;
  let imageVariations = []; // up to 4 variations for Pro users

  if (parsed.imagePrompt) {
    const origin = req.headers.origin || 'https://rsa-studio.vercel.app';
    const basePrompt = parsed.imagePrompt + modelHint;
    const dalleKey = process.env.OPENAI_API_KEY;
    const hasImagen = !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

    // Helper: upload a URL to Blob for permanence
    async function uploadToBlob(srcUrl, suffix = '') {
      if (!process.env.BLOB_READ_WRITE_TOKEN) return srcUrl;
      try {
        const { put } = await import("@vercel/blob");
        const buf = Buffer.from(await (await fetch(srcUrl)).arrayBuffer());
        const blob = await put(`meta-ad-${Date.now()}${suffix}.png`, buf, {
          access: "public", contentType: "image/png",
          token: process.env.BLOB_READ_WRITE_TOKEN,
        });
        return blob.url;
      } catch { return srcUrl; }
    }

    // Helper: call DALL-E
    async function genDalle(prompt, suffix = '') {
      if (!dalleKey) return null;
      try {
        const r = await fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${dalleKey}` },
          body: JSON.stringify({ model: "dall-e-3", prompt, n: 1, size: "1024x1024", quality: "standard" }),
        });
        const d = await r.json();
        const url = d.data?.[0]?.url || null;
        return url ? await uploadToBlob(url, suffix) : null;
      } catch { return null; }
    }

    // Helper: call Imagen
    async function genImagen(prompt, suffix = '') {
      if (!hasImagen) return null;
      try {
        const r = await fetch(`${origin}/api/imagen`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        });
        const d = await r.json();
        return d.imageUrl || null;
      } catch { return null; }
    }

    if (isPro) {
      // ── Pro: 4 variations in parallel ──────────────────────────────────────
      const lifestylePrompt = basePrompt.replace('Clean composition', 'Lifestyle setting, people using the product');
      const environmentPrompt = basePrompt + ' Natural outdoor environment, contextual setting.';
      const minimalPrompt = basePrompt + ' Minimal clean studio background, product hero shot.';

      const [v1, v2, v3, v4] = await Promise.all([
        imageModel === 'imagen' ? genImagen(basePrompt, '-v1') : genDalle(basePrompt, '-v1'),
        imageModel === 'imagen' ? genImagen(environmentPrompt, '-v2') : genDalle(lifestylePrompt, '-v2'),
        genImagen(basePrompt, '-v3'),
        genDalle(minimalPrompt, '-v4'),
      ]);

      imageVariations = [v1, v2, v3, v4].filter(Boolean);
      imageUrl = imageVariations[0] || null;
    } else {
      // ── Free/standard: single image ────────────────────────────────────────
      if (imageModel === 'imagen' && hasImagen) {
        imageUrl = await genImagen(basePrompt);
      }
      if (!imageUrl) {
        imageUrl = await genDalle(basePrompt);
      }
      imageVariations = imageUrl ? [imageUrl] : [];
    }
  } // end if (parsed.imagePrompt)

  return res.json({
    primaryTexts: parsed.primaryTexts || [],
    headlines: (parsed.headlines || []).map(h => h.slice(0, 40)),
    descriptions: (parsed.descriptions || []).map(d => d.slice(0, 30)),
    imageUrl,
    imageVariations,
    imagePrompt: parsed.imagePrompt,
  });
}
