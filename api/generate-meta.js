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

  const { url, language = "English", imageModel = "dalle", isPro = false, audienceBrief = null } = req.body || {};
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

${audienceBrief ? `
Audience Brief:
- Messaging tone: ${audienceBrief.messagingTone || ''}
- Copy angles: ${(audienceBrief.copySignals || []).join(', ')}
- Pain points: ${(audienceBrief.painPoints || []).join(', ')}
- Demographics: ${JSON.stringify(audienceBrief.demographics || {})}
Use these signals to sharpen the ad copy. The primary text should speak directly to the pain points and motivations of this audience.
` : ''}
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
        model: "claude-sonnet-4-6",
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
  // Images generated client-side via /api/imagen to avoid timeout
  // Pass prompts back to frontend for async generation
  let imageUrl = null;
  let imageVariations = [];

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
      // ── Build scene-ready prompts and return them for async client generation
      // ── Detect product category for scene-ready prompts ────────────────────
      const pageText = (pageContent + ' ' + url).toLowerCase();
      const isSkincare  = /skin|serum|moistur|cream|lotion|cleanser|toner|spf|sunscreen|facial|face|pleje|hudpleje/.test(pageText);
      const isHaircare  = /hair|shampoo|conditioner|scalp|hår/.test(pageText);
      const isCosmetics = /makeup|lipstick|mascara|foundation|blush|eyeshadow|cosmetic|beauty/.test(pageText);
      const isFashion   = /fashion|clothing|apparel|dress|wear|tøj|mode|jacket|shirt|shoe/.test(pageText);
      const isFood      = /food|drink|beverage|snack|coffee|tea|wine|beer|mad|drikke/.test(pageText);
      const isHome      = /home|interior|furniture|decor|living|kitchen|bath|hjem/.test(pageText);

      let sceneLocation = 'a clean minimal surface';
      let sceneObjects  = 'natural elements, botanicals and texture props';
      let sceneContext  = 'lifestyle context';

      if (isSkincare || isCosmetics) {
        sceneContext  = 'bathroom or vanity setting';
        sceneObjects  = 'soft towels, botanical ingredients, natural stones and dropper bottles';
        sceneLocation = 'a marble bathroom shelf or white vanity surface';
      } else if (isHaircare) {
        sceneContext  = 'bathroom or salon setting';
        sceneObjects  = 'towels, botanical herbs, a wooden comb and natural ingredients';
        sceneLocation = 'a wet bathroom shelf or wooden surface';
      } else if (isFashion) {
        sceneContext  = 'lifestyle fashion setting';
        sceneObjects  = 'natural textures, accessories and fabric details';
        sceneLocation = 'a clean urban or studio environment';
      } else if (isFood) {
        sceneContext  = 'kitchen or dining setting';
        sceneObjects  = 'fresh ingredients, wooden boards and natural props';
        sceneLocation = 'a kitchen counter or dining table';
      } else if (isHome) {
        sceneContext  = 'interior home setting';
        sceneObjects  = 'natural textures, plants and soft lighting elements';
        sceneLocation = 'a living room surface or shelf';
      }

      const gender = genderHint === 'female' ? 'woman' : genderHint === 'male' ? 'man' : 'person';

      // ── V1-V3: Scene-ready — empty product zone for remix ──────────────────
      const scenePrompt1 = `Editorial lifestyle photograph. A ${gender} in the background, softly blurred, in a ${sceneContext}. In the sharp foreground: ${sceneLocation} with ${sceneObjects} arranged naturally. A clearly visible empty space on the surface — enough room for a product bottle or container to be placed. Natural soft lighting, warm atmosphere. No product packaging or bottles. Photorealistic, 1:1 square format.${modelHint}`;

      const scenePrompt2 = `Professional flat lay photograph from above. A ${sceneContext} styled with ${sceneObjects} beautifully arranged. In the centre: a deliberately empty space on ${sceneLocation} — negative space where a product could be placed. Soft natural lighting, subtle shadows. No product packaging, no bottles, no containers. Photorealistic, 1:1 square format, editorial quality.`;

      const scenePrompt3 = `Atmospheric lifestyle scene in a ${sceneContext}. ${sceneObjects} placed artfully around ${sceneLocation}. A prominent empty surface area in the foreground, well-lit and clearly defined. Shallow depth of field, warm natural tones. No product packaging, no bottles, no text or labels. Photorealistic, 1:1 square format.${modelHint}`;

      // ── V4-V6: Direct use — AI-generated product in scene ─────────────────
      const directPrompt4 = basePrompt + ` Lifestyle ${sceneContext}, natural ambient lighting, product prominently featured in foreground.`;
      const directPrompt5 = basePrompt + ' Clean studio background, soft professional lighting, product as hero. Minimal, elegant, high-end advertising photography.';
      const directPrompt6 = basePrompt + ` Contextual ${sceneContext}, product in natural use setting. Warm natural light, editorial style.`;

      // Return prompts to frontend for async image generation
      return res.json({
        primaryTexts: parsed.primaryTexts || [],
        headlines: (parsed.headlines || []).map(h => h.slice(0, 40)),
        descriptions: (parsed.descriptions || []).map(d => d.slice(0, 30)),
        imageUrl: null,
        imageVariations: [],
        imagePrompt: parsed.imagePrompt,
        imagePrompts: {
          s1: scenePrompt1,
          s2: scenePrompt2,
          s3: scenePrompt3,
          v1: directPrompt4,
          v2: directPrompt5,
          v3: directPrompt6,
        },
        isPro: true,
      });
    } else {
      // ── Free/standard: single DALL-E image (fast) ──────────────────────────
      if (!imageUrl) imageUrl = await genDalle(basePrompt);
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
