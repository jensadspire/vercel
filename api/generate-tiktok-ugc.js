/**
 * /api/generate-tiktok-ugc — UGC TikTok Generator (parallel path to /api/generate-tiktok)
 *
 * The UGC video path: the creator's photo is the OPENING FRAME, and the video is an
 * authentic, phone-filmed UGC clip — NOT a polished product-morph template. Kling-pinned
 * (most UGC-friendly engine + the TikTok hook is tuned for it). No Creative Studio
 * templates. Copy is first-person creator voice seeded by the creator's caption.
 *
 * ON-SCREEN CAPTIONS: Kling garbles rendered text, so the Kling prompt stays visuals-only.
 * Clean TikTok-style captions are returned separately as `overlayCaptions` (timed lines)
 * for a post-process burn (same approach as the Rendi AI-label) — delivered, not rendered
 * by the model.
 *
 * Payload: { url, language, ugc: { image, creator, handle, caption, captionLang }, pageContent?, productDescription? }
 */

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

// UGC-native storyboard — authentic handheld creator video, animating the reference photo.
const UGC_ARCHETYPE = {
  label: "UGC Handheld",
  instructions: `- Video storyboard: 3 scenes — authentic "UGC Handheld" style. This is real, phone-filmed user-generated content: handheld feel, natural light, slightly imperfect framing, genuine and unpolished — NOT a glossy studio ad. It opens on the exact person/scene from the reference image and brings it to life.
  Scene 1 (0-3s): Open on the creator/subject from the reference image in their real setting — holding, wearing or showing the product naturally, as if filming themselves on a phone. Handheld, candid, warm natural light.
  Scene 2 (3-6s): A quick authentic beat — the product in genuine use, a close real-life detail, or the creator reacting positively. Casual phone-camera energy, natural movement, true-to-life.
  Scene 3 (6-10s): A confident, genuine closing beat — the creator with the product, approachable and real, a natural "you should try this" recommendation moment.`,
  json: `"storyboard": [
    { "scene": 1, "timing": "0-3s", "title": "Creator Intro", "description": "Creator in a real setting showing the product, handheld candid phone-filmed feel" },
    { "scene": 2, "timing": "3-6s", "title": "In Use", "description": "Authentic beat — product in genuine use or a real reaction, casual phone energy" },
    { "scene": 3, "timing": "6-10s", "title": "Genuine Close", "description": "Confident real recommendation moment, creator with the product" }
  ]`,
};

// UGC style + text handling. Note the deliberate contrast with the branded NO_TEXT_RULE:
// the AD is designed to carry on-screen captions, but Kling itself renders none (it garbles
// text) — captions come back as overlayCaptions for a post-process burn.
const UGC_STYLE_RULE = `- UGC AUTHENTICITY: phone-filmed, handheld, natural light, real and unpolished — like a creator's own clip, never a corporate studio ad. Keep it warm, candid and genuine.
- VIDEO TEXT: the Kling video prompt and storyboard describe ONLY what the camera sees (no rendered text, captions, logos or overlays) — the model garbles on-screen text. The TikTok-style captions are delivered SEPARATELY in overlayCaptions (clean text, burned on in post), so DESIGN the clip to leave natural room for a top/centre caption, but do not ask the model to render any text.`;

// Keep the creator + product identical to the opening reference image.
const UGC_MUST_KEEP = `- MUST-KEEP: keep the EXACT person from the opening reference image (same face, hair, build, styling) and the EXACT product (identical colour, shape, material) in every scene they appear. Do not swap, recolour or invent a different person or product. 9:16 vertical, authentic handheld UGC feel.`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key not configured" });

  const { url, language = "English", ugc = {}, pageContent = "", audienceBrief = null } = req.body || {};
  if (!url) return res.status(400).json({ error: "url is required" });
  if (!ugc || !ugc.image) return res.status(400).json({ error: "ugc.image is required (the creator photo)" });

  const creator = (ugc.creator || ugc.handle || "").toString().replace(/^@/, "").slice(0, 60);
  const caption = (ugc.caption || "").toString().slice(0, 600);
  const captionLang = (ugc.captionLang || "").toString().slice(0, 20);

  // ── Scrape for product facts if not provided ────────────────────────────────
  let content = pageContent;
  let productDescription = req.body.productDescription || "";
  if (!content) {
    try {
      const scrapeRes = await fetch(`${req.headers.origin || "https://" + req.headers.host}/api/scrape`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const scrapeData = await scrapeRes.json();
      content = scrapeData.content || scrapeData.text || "";
      if (!productDescription) productDescription = scrapeData.metaDescription || "";
    } catch (_) {}
  }

  // ── Brand name from URL ─────────────────────────────────────────────────────
  let brand = "";
  try {
    const domain = new URL(url).hostname.replace("www.", "");
    brand = domain.split(".")[0];
    brand = brand.charAt(0).toUpperCase() + brand.slice(1);
  } catch (_) {}

  const prompt = `You are a UGC TikTok creator scripting your own authentic in-feed video for this product. Write it as the creator (@${creator || "a real creator"}) would — first-person, casual, genuine, native to TikTok. Not a brand ad.

URL: ${url}
Brand: ${brand}
Page content: ${content.slice(0, 1000)}
Product description (accurate, retailer-written — USE THIS for the product's type, colour, material; never contradict it): ${(productDescription || "").slice(0, 600)}
Language: ${language}

CREATOR SIGNAL (the voice & angle — the creator's own words${captionLang ? `, originally in ${captionLang}` : ""}; capture the feeling and point of view, but WRITE everything in ${language}, re-expressed not literally translated):
- Creator: @${creator || "creator"}
- Their caption: "${caption || "(no caption — infer an authentic enthusiastic first-person angle from the product)"}"

${audienceBrief ? `Audience signals — tone: ${audienceBrief.messagingTone || ""}; angles: ${(audienceBrief.copySignals || []).join(", ")}; pain points: ${(audienceBrief.painPoints || []).join(", ")}.\n` : ""}
UGC TikTok rules:
- hookLine: first 3 seconds, stop the scroll, first-person, max 8 words. Sounds like a real person, not a slogan.
- primaryText: 1-2 punchy conversational sentences, authentic creator voice, emojis allowed. Max 120 chars.
- cta: short action phrase, max 4 words (e.g. "Go get it", "Link in bio").
- hashtags: 4-6, mix broad + niche, native to TikTok. Include an organic #ugc-style tag if natural. No spaces.
- overlayCaptions: 3 short on-screen caption lines (the TikTok-style captions that will be burned onto the video). Each ≤ 6 words, punchy, first-person, one per beat, timed to the scenes. These ARE meant to appear on screen.
${UGC_ARCHETYPE.instructions}
${UGC_STYLE_RULE}
${UGC_MUST_KEEP}
- Write in ${language}; never start with the brand name; sound native to TikTok, like a creator filming themselves.

Return ONLY valid JSON — no markdown, no preamble:
{
  "hookLine": "Stop-scroll first-person opening (max 8 words)",
  "primaryText": "Authentic creator caption (max 120 chars, emojis ok)",
  "cta": "Call to action (max 4 words)",
  "hashtags": ["#tag1", "#tag2", "#tag3", "#tag4", "#tag5"],
  "overlayCaptions": [
    { "timing": "0-3s", "text": "on-screen hook caption (≤6 words)" },
    { "timing": "3-6s", "text": "on-screen middle caption (≤6 words)" },
    { "timing": "6-10s", "text": "on-screen CTA caption (≤4 words)" }
  ],
  ${UGC_ARCHETYPE.json},
  "videoPrompt": "Kling video prompt, max 900 chars — 9:16 vertical, authentic handheld UGC clip following the storyboard above. Describe camera feel (handheld, phone-filmed), natural light, the creator and product, and natural movement for each beat. Keep the exact person and product from the opening reference image. NO on-screen text, captions, logos or overlays in the video itself."
}`;

  let parsed;
  try {
    const claudeRes = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
    });
    const claudeData = await claudeRes.json();
    const raw = claudeData.content?.[0]?.text || "";
    if (!raw) {
      const errMsg = claudeData.error?.message || JSON.stringify(claudeData);
      return res.status(500).json({ error: "UGC TikTok copy generation failed", detail: errMsg });
    }
    parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch (e) {
    return res.status(500).json({ error: "UGC TikTok copy generation failed", detail: e.message });
  }

  console.log("[UGC TikTok] creator=@" + creator + " engine=kling\n  videoPrompt: " + (parsed.videoPrompt || "").slice(0, 600));
  return res.status(200).json({
    ugcMode: true,
    engine: "kling",
    creator: creator,
    captionLang: captionLang,
    hookLine: parsed.hookLine || "",
    primaryText: parsed.primaryText || "",
    cta: parsed.cta || "",
    hashtags: parsed.hashtags || [],
    overlayCaptions: Array.isArray(parsed.overlayCaptions) ? parsed.overlayCaptions.slice(0, 4) : [],
    storyboard: parsed.storyboard || [],
    videoPrompt: parsed.videoPrompt || "",
    brand,
    archetype: "ugc-handheld",
    storyboardFormat: UGC_ARCHETYPE.label,
  });
}
