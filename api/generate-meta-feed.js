/**
 * /api/generate-meta-feed — B-path Meta generator for the Bulk Feed flow.
 *
 * Takes a NORMALIZED feed product (image_link + copy already in hand) and generates
 * Meta ad copy WITHOUT scraping and WITHOUT the hero-image guessing machine — the feed's
 * images are already ad-grade, so we use them directly. Returns the SAME response shape as
 * /api/generate-meta so the frontend renders it identically. Parallel, additive: the
 * original /api/generate-meta is untouched.
 *
 * Body: { product: { link, title, description, images[], image, brand, productType, price, currency },
 *         language?, keywords?, audienceBrief? }
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

  const { product = {}, language = "English", keywords = [], audienceBrief = null } = req.body || {};
  const link = product.link || "";
  const title = product.title || "";
  const description = product.description || "";
  const brand = product.brand || "";
  const productType = product.productType || "";
  const rawImages = Array.isArray(product.images) && product.images.length ? product.images
                  : (product.image ? [product.image] : []);
  if (!title && !description && !link) return res.status(400).json({ error: "product (title/description/link) is required" });

  // ── Feed images are already ad-grade — use directly, no scoring, no scrape ──
  const feedImages = [...new Set(rawImages.filter(s => typeof s === "string" && /^https?:\/\//i.test(s)))];
  const heroProductImage = feedImages[0] || null;
  const secondaryImage = feedImages[1] || null;
  const tertiaryImage = feedImages[2] || null;
  const allImages = feedImages.slice(0, 16).filter(img => img !== heroProductImage);

  // ── Gender signal (same lexicon as /api/generate-meta) — from feed copy ──
  const genderSignals = {
    female: ["damen", "women", "woman", "female", "femme", "donna", "mujer", "kvinder", "dame", "ladies", "girl", "she/her"],
    male:   ["herren", "men", "man", "male", "homme", "uomo", "hombre", "herr", "mænd", "guys", "he/him"],
  };
  const textToScan = (title + " " + description + " " + productType + " " + link).toLowerCase();
  const femaleScore = genderSignals.female.filter(w => textToScan.includes(w)).length;
  const maleScore = genderSignals.male.filter(w => textToScan.includes(w)).length;
  const genderHint = femaleScore > maleScore ? "female" : maleScore > femaleScore ? "male" : null;
  const modelHint = genderHint === "female" ? " Feature a female model if people are shown."
                  : genderHint === "male"   ? " Feature a male model if people are shown." : "";

  // ── Meta copy prompt — fed by the feed record, not a scrape ──
  const prompt = `You are an expert Meta (Facebook & Instagram) ads copywriter.

Analyse this product and write scroll-stopping Meta ad copy in ${language}.

Product title: ${title}
Brand: ${brand}
Category: ${productType}
Product URL: ${link}
Product description (accurate, retailer-written — treat as the authoritative source for the product's TYPE, intended AUDIENCE/gender, and COLOUR; never contradict it, e.g. never call a women's item men's): ${description.slice(0, 600)}

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
  "imagePrompt": "Detailed prompt for a 1:1 Meta ad image — photorealistic, clean composition, no text overlays, no logos.${modelHint} Show the product in a lifestyle setting relevant to the brand. Suitable for Facebook/Instagram feed."
}
${keywords && keywords.length > 0 ? `
Focus keywords to include in copy: ${keywords.join(", ")}` : ""}
${audienceBrief ? `
Audience Brief:
- Messaging tone: ${audienceBrief.messagingTone || ""}
- Copy angles: ${(audienceBrief.copySignals || []).join(", ")}
- Pain points: ${(audienceBrief.painPoints || []).join(", ")}
Use these signals to sharpen the ad copy.` : ""}
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
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
    });
    const claudeData = await claudeRes.json();
    const raw = claudeData.content?.[0]?.text || "";
    if (!raw) {
      const errMsg = claudeData.error?.message || JSON.stringify(claudeData);
      return res.status(503).json({ error: "Extended workload at the moment — please check back a bit later.", detail: errMsg });
    }
    const clean = raw.replace(/```json|```/g, "").trim();
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      return res.status(500).json({ error: "Copy generation failed", detail: "JSON parse: " + parseErr.message, raw: raw.slice(0, 200) });
    }
  } catch (e) {
    return res.status(503).json({ error: "Extended workload at the moment — please check back a bit later.", detail: e.message });
  }

  // Same response shape as /api/generate-meta (non-Pro path) — feed images as the real product hero.
  return res.status(200).json({
    primaryTexts: parsed.primaryTexts || [],
    headlines: (parsed.headlines || []).map(h => String(h).slice(0, 40)),
    descriptions: (parsed.descriptions || []).map(d => String(d).slice(0, 30)),
    imageUrl: null,
    imageVariations: [],
    imagePrompt: parsed.imagePrompt || "",
    heroProductImage,
    secondaryImage,
    tertiaryImage,
    homepageImage: null,
    allImages,
    source: "feed",
  });
}
