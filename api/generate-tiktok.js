/**
 * /api/generate-tiktok — TikTok Ad Suite Generator
 * Generates: hook line, primary text, CTA, hashtags, video storyboard.
 *
 * Storyboard is ARCHETYPE-driven on the Kling path:
 *   scene_reveal (default) | studio_spin | lifestyle_montage | detail_focus | no_preference
 * videoEngine === 'runway' keeps its condensed 2-scene product→lifestyle skeleton.
 *
 * Option B (source-level overlay fix): storyboard scenes describe VISUALS ONLY — the
 * prompt explicitly forbids on-screen text / captions / hooks / CTAs / logos / brand /
 * domain overlays in every scene, for all archetypes and both engines. The ad's hook &
 * CTA are still produced as COPY fields (they sit BESIDE the video, never inside it).
 * This replaces the old fixed "Hook → … → CTA Close" skeleton that caused Kling to
 * render garbled on-screen text.
 *
 * storyboardOnly:true → returns only { storyboard, videoPrompt } — used when the user
 *   switches archetype in the video tab, so the board updates without touching copy.
 */

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

// ── Storyboard archetypes (Kling). Fixed VISUAL skeletons — no text/hook/CTA beats. ──
const ARCHETYPES = {
  scene_reveal: {
    label: "Scene Reveal",
    instructions: `- Video storyboard: 3 scenes — the "Scene Reveal" style. Its SIGNATURE is a single seamless morph: the product on a plain background transforms — in one continuous unbroken shot — into the same product sitting in a full lifestyle room. This elegant slide-into-the-scene IS the whole point; it must NEVER be a hard cut between two separate shots, and must NOT cut away to a hand, a material close-up, or a person.
  Scene 1 (0-3s): The product alone on a clean, minimal, softly-lit background. Slow, steady push-in; the camera locks onto the product and holds it centred.
  Scene 2 (3-7s): ONE CONTINUOUS UNBROKEN SHOT, camera still locked on the product: the plain background gently melts and dissolves away while a warm, real-world environment (a styled living room, soft daylight through windows) grows and materialises into place AROUND the product in the very same frame — as if the product is smoothly sliding into a finished scene. The product never leaves the frame and never changes shape or colour. A seamless, almost dreamlike transformation from blank backdrop to full room. Do NOT cut to a new shot; do NOT insert a close-up of hands or material.
  Scene 3 (7-10s): The transformation completes into the finished lifestyle hero shot — the product naturally at home in the fully-formed room, warm and aspirational, with a gentle camera drift.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-3s", "title": "Clean Product", "description": "Product alone on a clean minimal background, slow push-in" },
    { "scene": 2, "timing": "3-7s", "title": "World Opens Up", "description": "One continuous shot: background dissolves and the room materialises around the product — seamless morph, no cut, no hand close-up" },
    { "scene": 3, "timing": "7-10s", "title": "Lifestyle Hero", "description": "Product in the finished aspirational scene, gentle drift" }
  ]`,
  },
  studio_spin: {
    label: "Studio Spin",
    instructions: `- Video storyboard: 3 scenes — the "Studio Spin" style (clean rotating hero product with dynamic light):
  Scene 1 (0-3s): Product centred on a seamless studio background with a dramatic key light. A smooth 360° rotation begins.
  Scene 2 (3-7s): The rotation continues as the lighting shifts to highlight form, material and detail; subtle reflections and highlights travel across the surface.
  Scene 3 (7-10s): The spin settles on the strongest hero angle — product crisp and premium — with a slight camera pull-back.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-3s", "title": "Spin Begins", "description": "Product on seamless studio background, dramatic key light, rotation starts" },
    { "scene": 2, "timing": "3-7s", "title": "Light Play", "description": "Rotation continues, light highlights form and material" },
    { "scene": 3, "timing": "7-10s", "title": "Hero Angle", "description": "Settles on the hero angle, premium and crisp, slight pull-back" }
  ]`,
  },
  lifestyle_montage: {
    label: "Lifestyle Montage",
    instructions: `- Video storyboard: 3 scenes — the "Lifestyle Montage" style (product across real-world moments of use):
  Scene 1 (0-3s): The product in a genuine moment of use in a real setting — someone reaching for or using it. Natural, warm, authentic.
  Scene 2 (3-6s): A second real-life moment in a different setting — the product in active use, aspirational and true-to-life.
  Scene 3 (6-10s): A final confident lifestyle beat — the product clearly featured, ending on an aspirational real-world moment.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-3s", "title": "In Use", "description": "Product in a genuine moment of use, real setting" },
    { "scene": 2, "timing": "3-6s", "title": "Different Moment", "description": "A second real-life setting, product in active use" },
    { "scene": 3, "timing": "6-10s", "title": "Confident Close", "description": "Final aspirational lifestyle beat, product featured" }
  ]`,
  },
  detail_focus: {
    label: "Detail Focus",
    instructions: `- Video storyboard: 3 scenes — the "Detail Focus" style (macro craftsmanship, then reveal):
  Scene 1 (0-3s): Extreme macro of the product's texture, material or craftsmanship — shallow depth of field, slow drift across the surface.
  Scene 2 (3-7s): The camera reveals more through successive close details (stitching, grain, finish, moving parts) — tactile and premium.
  Scene 3 (7-10s): Pull back to reveal the full product in a clean, elegant setting — the craftsmanship now seen in context.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-3s", "title": "Macro Texture", "description": "Extreme macro of material/craftsmanship, shallow depth, slow drift" },
    { "scene": 2, "timing": "3-7s", "title": "Close Details", "description": "Successive close details — stitching, grain, finish" },
    { "scene": 3, "timing": "7-10s", "title": "Full Reveal", "description": "Pull back to the full product in an elegant setting" }
  ]`,
  },
  no_preference: {
    label: "No preference",
    instructions: `- Video storyboard: 3-4 scenes — choose the structure that best suits THIS product for a premium 10-second vertical ad. Smooth camera movement, aspirational lighting, product clearly the hero throughout. Each scene 1-2 sentences describing only the visuals.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-3s", "title": "Opening", "description": "Visual description of the opening beat" },
    { "scene": 2, "timing": "3-6s", "title": "Development", "description": "Product shown in context or use" },
    { "scene": 3, "timing": "6-10s", "title": "Hero Close", "description": "Aspirational closing product shot" }
  ]`,
  },
};

// The source-level overlay rule (Option B) — appended to every storyboard prompt.
const NO_TEXT_RULE = `- CRITICAL — VISUALS ONLY: every storyboard scene and the video prompt describe ONLY what the camera sees (composition, lighting, setting, motion, the product). NEVER specify on-screen text, captions, titles, subtitles, hooks, questions, taglines, CTAs, buttons, logos, brand names, or domain/URL overlays in any scene. The finished video must contain NO rendered text of any kind. (The ad's hook and CTA are delivered separately as copy, not inside the video.)`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key not configured" });

  const {
    url, language = "English", audienceBrief = null, pageContent = "", pageMeta = {},
    videoEngine = "kling", archetype = "scene_reveal", storyboardOnly = false,
  } = req.body;
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

  const isRunway = videoEngine === "runway";
  const arch = ARCHETYPES[archetype] || ARCHETYPES.scene_reveal;

  // ── Storyboard skeleton: Runway keeps 2-scene product→lifestyle; Kling uses the archetype ──
  const storyboardInstructions = isRunway ? `
- Video storyboard: 2 scenes ONLY — designed for a 10-second lifestyle/fashion video:
  Scene 1 (0-4s): PRODUCT SHOWCASE — Product presented beautifully in its original setting. Clean, aspirational shot. The product is the hero — clearly visible, well-lit. Camera slowly moves in or orbits the product.
  Scene 2 (4-10s): HUMAN LIFESTYLE MOMENT — A real person is WEARING or USING the product in an aspirational real-life setting. The person must be clearly visible — this scene MUST show a human being, not just the product alone. Confident, natural, aspirational.
- Both scenes must flow seamlessly — same colour palette, same mood, same lighting style.` : `
${arch.instructions}
- Each scene 1-2 sentences. Product clearly the hero, smooth cinematic camera movement, aspirational lighting.`;

  const storyboardJson = isRunway ? `"storyboard": [
    { "scene": 1, "timing": "0-4s", "title": "Product Showcase", "description": "Beautiful product shot in original setting" },
    { "scene": 2, "timing": "4-10s", "title": "Lifestyle Moment", "description": "Product worn/used in aspirational real-life scene" }
  ]` : arch.json;

  const videoPromptGuide = isRunway
    ? `Runway video prompt, max 900 chars — 9:16 vertical. Scene 1 (0-4s): clean product showcase, product is the hero, slow orbiting camera, aspirational lighting. Hard cut at 4s. Scene 2 (4-10s): a person WEARING or USING the product in a real lifestyle setting. Same warm palette. Cinematic and elegant. NO on-screen text, captions, logos or overlays.`
    : `Kling video prompt, max 900 chars — 9:16 vertical, following the '${arch.label}' structure above. Describe camera movement, lighting, setting and mood for each beat. Product clearly visible throughout. NO on-screen text, captions, logos, brand names or overlays of any kind.`;

  // ── storyboardOnly: regenerate just the board (archetype switch in the video tab) ──
  if (storyboardOnly) {
    const sbPrompt = `You are a video storyboard director. For this product, produce ONLY a storyboard and a matching video prompt in the '${isRunway ? "product-to-lifestyle" : arch.label}' style.

URL: ${url}
Brand: ${brand}
Page content: ${content.slice(0, 800)}
Language: ${language}
${storyboardInstructions}
${NO_TEXT_RULE}

Return ONLY valid JSON (no markdown, no preamble):
{
  ${storyboardJson},
  "videoPrompt": "${videoPromptGuide}"
}`;
    try {
      const r = await fetch(ANTHROPIC_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 900, messages: [{ role: "user", content: sbPrompt }] }),
      });
      const d = await r.json();
      const raw = d.content?.[0]?.text || "";
      if (!raw) return res.status(500).json({ error: "Storyboard generation failed", detail: d.error?.message || "" });
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
      return res.status(200).json({
        storyboard: parsed.storyboard || [],
        videoPrompt: parsed.videoPrompt || "",
        archetype: isRunway ? "runway-2scene" : archetype,
        storyboardFormat: isRunway ? "2-scene" : arch.label,
      });
    } catch (e) {
      return res.status(500).json({ error: "Storyboard generation failed", detail: e.message });
    }
  }

  // ── Full ad-suite prompt ──────────────────────────────────────────────────────
  const prompt = `You are an expert TikTok ad copywriter. Write a complete TikTok in-feed ad for this product/brand.

URL: ${url}
Brand: ${brand}
Page content: ${content.slice(0, 1000)}
Language: ${language}
Video format: ${isRunway ? "Fashion/lifestyle — 2-scene product-to-life format" : `'${arch.label}' archetype`}

${audienceBrief ? `Audience Brief:
- Name: ${audienceBrief.audienceName || ""}
- Messaging tone: ${audienceBrief.messagingTone || ""}
- Copy angles: ${(audienceBrief.copySignals || []).join(", ")}
- Pain points: ${(audienceBrief.painPoints || []).join(", ")}
Use these signals to sharpen the copy.` : ""}

TikTok ad rules:
- Hook line: First 3 seconds — must stop the scroll. Max 8 words. Bold, direct, curiosity-driven.
- Primary text: 1-2 punchy sentences. Conversational, energetic TikTok voice. Max 100 chars total.
- CTA: Short action phrase. Max 4 words. (e.g. "Shop now", "Try it today", "Link in bio")
- Hashtags: 4-6 relevant hashtags. Mix broad (#fashion) and niche (#danishdesign). No spaces.
${storyboardInstructions}
${NO_TEXT_RULE}
- Write in ${language}
- Never start with the brand name
- Sound native to TikTok — not like a TV commercial

Return ONLY valid JSON:
{
  "hookLine": "Stop-scroll opening line (max 8 words)",
  "primaryText": "Main ad copy (max 100 chars)",
  "cta": "Call to action (max 4 words)",
  "hashtags": ["#tag1", "#tag2", "#tag3", "#tag4", "#tag5"],
  ${storyboardJson},
  "videoPrompt": "${videoPromptGuide}"
}`;

  // ── Call Claude ───────────────────────────────────────────────────────────────
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
      return res.status(500).json({ error: "TikTok copy generation failed", detail: errMsg });
    }
    parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
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
    archetype: isRunway ? "runway-2scene" : archetype,
    storyboardFormat: isRunway ? "2-scene" : arch.label,
  });
}
