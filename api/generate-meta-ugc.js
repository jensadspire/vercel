/**
 * /api/generate-meta-ugc — UGC Meta Ad Generator (parallel path to /api/generate-meta)
 *
 * The UGC path: a real creator's photo IS the hero (no AI image generation), and the
 * copy is written in the creator's authentic first-person voice — product FACTS from
 * the URL scrape, VOICE/ANGLE from the creator's caption. Branded /api/generate-meta
 * is untouched; this is a separate clone so the UGC path can diverge freely.
 *
 * Payload: { url, language, ugc: { image, creator, handle, caption, captionLang }, keywords?, audienceBrief? }
 * Returns the same copy shape the frontend already renders (primaryTexts / headlines /
 * descriptions), with the UGC image as imageUrl + heroProductImage, plus scraped
 * product images as allImages for optional swap.
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

  const { url, language = "English", ugc = {}, keywords = [], audienceBrief = null } = req.body || {};
  if (!url) return res.status(400).json({ error: "url is required" });
  if (!ugc || !ugc.image) return res.status(400).json({ error: "ugc.image is required (the creator photo)" });

  const creator = (ugc.creator || ugc.handle || "").toString().replace(/^@/, "").slice(0, 60);
  const caption = (ugc.caption || "").toString().slice(0, 600);
  const captionLang = (ugc.captionLang || "").toString().slice(0, 20);

  // ── Scrape the URL for PRODUCT FACTS only (the hero image is the UGC photo) ──
  let pageContent = "", metaDescription = "", title = "", h1 = "", scrapeImages = [];
  try {
    const scrapeRes = await fetch(`${req.headers.origin || "https://" + req.headers.host}/api/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const scrapeData = await scrapeRes.json();
    pageContent = scrapeData.content || scrapeData.text || "";
    metaDescription = scrapeData.metaDescription || "";
    title = scrapeData.title || "";
    h1 = scrapeData.h1 || "";
    scrapeImages = Array.isArray(scrapeData.images) ? scrapeData.images : [];
  } catch (_) {
    pageContent = url;
  }

  const productFacts = [
    title ? `Title: ${title}` : "",
    h1 ? `Heading: ${h1}` : "",
    metaDescription ? `Description: ${metaDescription}` : "",
    pageContent ? `Page: ${pageContent.slice(0, 1800)}` : "",
  ].filter(Boolean).join("\n").slice(0, 2600);

  // ── UGC-register copy prompt ───────────────────────────────────────────────
  const prompt = `You are writing UGC (user-generated content) ad copy for Meta (Facebook & Instagram) in ${language}.

This ad pairs a REAL creator's photo with a product. Write copy that sounds like the creator THEMSELVES casually recommending it — personal, first-person, warm, emoji-friendly — NOT polished brand copy and NOT a TV-style tagline.

PRODUCT FACTS (authoritative — retailer-written; never contradict the product's type, intended audience/gender, or colour):
${productFacts || url}

CREATOR SIGNAL (the VOICE and ANGLE to adopt — the creator's own words${captionLang ? `, originally in ${captionLang}` : ""}; capture its vibe and point of view, but WRITE the final copy in ${language} — do not translate literally, re-express the feeling):
- Creator: @${creator || "creator"}
- Their caption: "${caption || "(no caption — infer an authentic, enthusiastic first-person angle from the product)"}"

Frame the ad as "{the product}, discovered / used / styled by @${creator || "a real creator"}": product facts stay accurate, but the hook, tone and angle come from the creator's voice. First-person ("I", "my"), conversational, a few tasteful emojis (1-3 per primary text), native to Reels/feed — like a friend's honest recommendation.

Return ONLY valid JSON — no markdown, no preamble:
{
  "primaryTexts": [
    "First-person creator-voice primary text variant 1 (80-125 chars, authentic hook, 1-3 emojis)",
    "Variant 2 — different angle (what won me over / before-after feeling / little ritual)",
    "Variant 3 — social-proof or 'you need this' angle"
  ],
  "headlines": [
    "Headline 1 (max 40 chars, benefit-led, casual)",
    "Headline 2 (max 40 chars, different benefit)",
    "Headline 3 (max 40 chars, CTA or soft offer)"
  ],
  "descriptions": [
    "Link description 1 (max 30 chars)",
    "Link description 2 (max 30 chars)"
  ]
}
${keywords && keywords.length > 0 ? `\nWeave in where natural: ${keywords.join(", ")}` : ""}
${audienceBrief ? `\nAudience signals — tone: ${audienceBrief.messagingTone || ""}; angles: ${(audienceBrief.copySignals || []).join(", ")}; pain points: ${(audienceBrief.painPoints || []).join(", ")}. Let the creator voice speak to these.` : ""}
Rules:
- Write in ${language}, first-person creator voice (never start with the brand name)
- Emojis allowed and encouraged (1-3 per primary text), used naturally
- Product facts must stay accurate to the retailer description
- Headlines ≤ 40 chars; descriptions ≤ 30 chars`;

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
      console.error("UGC meta JSON parse failed. First 300:", raw.slice(0, 300));
      return res.status(500).json({ error: "Copy generation failed", detail: "JSON parse: " + parseErr.message, raw: raw.slice(0, 200) });
    }
  } catch (e) {
    console.error("UGC meta Claude call failed:", e.message);
    return res.status(503).json({ error: "Extended workload at the moment — please check back a bit later.", detail: e.message });
  }

  // Hero is the UGC image. Offer scraped product images as swap alternates.
  const BLOCKED = /cart\/|frifreight|widget|badge|trustpilot|pricerunner|klarna|mobilepay|paypal|visa|mastercard|shipping|delivery|payment|%7B|\{width\}|\{height\}|_logo\.|logo_|logo-|\/logo/i;
  const altImages = scrapeImages.filter(img => img && !BLOCKED.test(img) && img !== ugc.image).slice(0, 12);

  return res.json({
    ugcMode: true,
    creator: creator,
    captionUsed: caption,
    captionLang: captionLang,
    primaryTexts: parsed.primaryTexts || [],
    headlines: (parsed.headlines || []).map(h => String(h).slice(0, 40)),
    descriptions: (parsed.descriptions || []).map(d => String(d).slice(0, 30)),
    imageUrl: ugc.image,
    imageVariations: [ugc.image],
    heroProductImage: ugc.image,
    allImages: altImages,
  });
}
