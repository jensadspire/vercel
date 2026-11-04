// api/seq-storyboard.js
// ─────────────────────────────────────────────────────────────────────────────
// Sequential Ad storyboard composer — the "secret sauce" that turns a funnel
// objective (+ persona, product, market, interaction mode) into a tailored video
// prompt for /api/seedance-byteplus. One composer, many layered inputs.
//
// Deterministic by design (no model call): predictable, free, fast, and tunable —
// the right foundation for validating output quality before it becomes the default
// generation path. An optional LLM-polish pass can layer on later behind a flag.
//
// HARD RULE: the video model never renders text. Price / promo copy is returned as
// an `overlay` instruction for the post-processing stage (alongside AI-label + C2PA),
// so on-screen text is always correct, legible and editable — never model-garbled.
//
// INPUT CONTRACT (POST body):
//   action:        'shot' (one objective) | 'sequence' (an objective chain)   [default 'shot']
//   objective:     funnel stage id for action:'shot'  (awareness|engagement|retargeting|conversion)
//   objectiveChain: string[] for action:'sequence'    (defaults to a sensible funnel)
//   persona:       { name?, subject? }   subject = 'woman'|'man'|'person'  (face held from Image 1)
//   usePersona:    bool (default true) — false → product-only showcase
//   product:       { title?, category?, imageUrl?, price?, currency?, onSale? }   (product = Image 2)
//   market:        explicit region key, OR
//   url:           a store/product URL → region auto-derived from the TLD (.dk/.se → Scandinavia …)
//   interactionMode: explicit (wear|use|consume|operate|present) — else derived from product.category
//   promo:         bool — on + a product price → a composited price overlay instruction
//   overlay:       explicit override { show, kind, text, position }
//   ratio:         '9:16' (default) | '1:1' | '16:9'
//
// OUTPUT: action:'shot' → { shot }, action:'sequence' → { shots: [...], chain, persona }
//   each shot = { objective, label, prompt, scene, market, interactionMode, usePersona, overlay, notes }
//
// Self-contained ESM, no deps. Tune the maps/recipes below — they are the product.
// ─────────────────────────────────────────────────────────────────────────────

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

// Never let the model draw text — overlays are composited post-render.
const NOTEXT = 'No on-screen text, captions, subtitles, logos or watermarks.';

// ── Objective recipes — what story each funnel stage tells ────────────────────
const OBJECTIVE_RECIPES = {
  awareness: {
    label: 'Awareness',
    personaAction: "introduced to the viewer for the first time, moving naturally and relaxed, making an inviting first impression",
    productAction: "revealed with an aspirational, attention-catching first impression",
    mood: "bright, aspirational and inviting",
    camera: "a smooth establishing shot with gentle camera movement and medium framing",
  },
  engagement: {
    label: 'Engagement',
    personaAction: "actively showing the product in use and reacting to a clear benefit moment, expressive and upbeat",
    productAction: "shown in action with a clear benefit moment and a satisfying detail",
    mood: "energetic, curious and upbeat",
    camera: "a dynamic camera with closer framing and a crisp product-detail insert",
  },
  retargeting: {
    label: 'Retargeting',
    personaAction: "speaking warmly toward the camera with a confident, reassuring endorsement that answers a hesitation",
    productAction: "presented in a trustworthy, reassuring way that answers a common hesitation",
    mood: "warm, sincere and trustworthy",
    camera: "intimate, steady, direct-to-camera framing",
  },
  conversion: {
    label: 'Conversion',
    personaAction: "presenting the product decisively with clear, confident call-to-action energy, inviting the viewer to act now",
    productAction: "presented decisively as a clean hero shot with confident call-to-action energy",
    mood: "high-energy, decisive and compelling",
    camera: "punchy, product-forward framing with a clean, bold finish",
  },
};
const OBJECTIVE_IDS = Object.keys(OBJECTIVE_RECIPES);
const DEFAULT_CHAIN = ['awareness', 'engagement', 'conversion'];
const MAX_CHAIN = 4;

// ── Market → environment (local flavour, auto-derived from the URL's TLD) ─────
const MARKETS = {
  scandinavia: { tlds: ['dk', 'se', 'no', 'fi', 'is'], scene: "a bright, minimalist Scandinavian setting with natural light, clean lines and muted tones" },
  uk:          { tlds: ['uk', 'co.uk'],                scene: "a tasteful, characterful British setting" },
  germany:     { tlds: ['de', 'at', 'ch'],            scene: "a clean, modern Central-European setting" },
  france:      { tlds: ['fr'],                         scene: "an elegant, refined French setting" },
  italy:       { tlds: ['it'],                         scene: "a warm Mediterranean Italian setting with golden light" },
  spain:       { tlds: ['es'],                         scene: "a sunlit Mediterranean Spanish setting" },
  netherlands: { tlds: ['nl', 'be'],                  scene: "a bright, modern Dutch setting" },
  us:          { tlds: ['us'],                         scene: "a bright, modern American setting" },
};
const DEFAULT_SCENE = "a bright, modern setting";

// ── Product category → interaction mode (how the persona meets the product) ───
const INTERACTIONS = {
  wear:    { cats: ['apparel', 'clothing', 'fashion', 'shoe', 'jacket', 'dress', 'coat', 'knit', 'denim', 'eyewear', 'glasses', 'sunglass', 'jewel', 'watch', 'bag', 'accessor', 'hat', 'scarf', 'shirt', 'trouser', 'pant'], clause: (t) => "wearing the " + t + " from Image 2" },
  use:     { cats: ['tool', 'gadget', 'device', 'kitchen', 'cookware', 'beauty', 'skincare', 'haircare', 'cleaning', 'garden', 'hardware', 'fitness', 'sport', 'brush', 'razor', 'bottle'], clause: (t) => "holding and actively using the " + t + " from Image 2" },
  consume: { cats: ['food', 'drink', 'beverage', 'snack', 'supplement', 'coffee', 'tea', 'wine', 'grocery', 'nutrition'], clause: (t) => "enjoying the " + t + " from Image 2" },
  operate: { cats: ['furniture', 'electronic', 'machine', 'equipment', 'appliance', 'heater', 'vacuum'], clause: (t) => "demonstrating the " + t + " from Image 2 in the setting" },
  present: { cats: [],                                                                                    clause: (t) => "presenting the " + t + " from Image 2 toward the camera" },
};
const INTERACTION_IDS = Object.keys(INTERACTIONS);

// ── Currency formatting for the price overlay (composited, never model-rendered) ─
const CUR_SYMBOL = { EUR: '€', USD: '$', GBP: '£', DKK: 'kr', SEK: 'kr', NOK: 'kr', CHF: 'CHF', PLN: 'zł' };
function formatPrice(price, currency) {
  const n = Number(String(price == null ? '' : price).replace(/[^0-9.,]/g, '').replace(',', '.'));
  const amount = Number.isFinite(n) ? String(Math.round(n * 100) / 100).replace(/\.0+$/, '') : String(price || '');
  const cur = String(currency || '').toUpperCase();
  const sym = CUR_SYMBOL[cur] || cur || '';
  if (sym === 'kr' || sym === 'zł') return (amount + ' ' + sym).trim();
  return (sym + amount).trim();
}

// ── Resolvers ────────────────────────────────────────────────────────────────
function marketFromUrl(url) {
  let host = '';
  try { host = new URL(/^https?:\/\//i.test(url) ? url : ('https://' + url)).hostname.toLowerCase(); } catch (_) { return null; }
  if (!host) return null;
  for (const key of Object.keys(MARKETS)) {
    for (const tld of MARKETS[key].tlds) {
      if (host === tld || host.endsWith('.' + tld)) return { key: key, scene: MARKETS[key].scene };
    }
  }
  return null;
}
function resolveMarket(ctx) {
  const explicit = ctx.market && String(ctx.market).toLowerCase();
  if (explicit && MARKETS[explicit]) return { key: explicit, scene: MARKETS[explicit].scene };
  const url = ctx.url || (ctx.product && ctx.product.link) || '';
  return marketFromUrl(url) || { key: 'default', scene: DEFAULT_SCENE };
}
function resolveInteraction(ctx) {
  const explicit = ctx.interactionMode && String(ctx.interactionMode).toLowerCase();
  if (explicit && INTERACTIONS[explicit]) return explicit;
  const cat = String((ctx.product && (ctx.product.category || ctx.product.productType)) || '').toLowerCase();
  if (cat) {
    for (const mode of INTERACTION_IDS) {
      if (INTERACTIONS[mode].cats.some(function (c) { return cat.includes(c); })) return mode;
    }
  }
  return 'present';
}
function buildOverlay(ctx) {
  if (ctx.overlay && ctx.overlay.show) {
    return { show: true, kind: ctx.overlay.kind || 'text', text: String(ctx.overlay.text || ''), position: ctx.overlay.position || 'lower-third', renderedBy: 'post-processing' };
  }
  if (ctx.promo && ctx.product && (ctx.product.price != null && ctx.product.price !== '')) {
    const price = formatPrice(ctx.product.price, ctx.product.currency);
    const text = ctx.product.onSale ? ('Now ' + price) : price;
    return { show: true, kind: 'price', text: text, position: 'lower-third', renderedBy: 'post-processing' };
  }
  return { show: false };
}

// ── The composer — one shot ──────────────────────────────────────────────────
export function buildShot(ctx, objectiveId) {
  const objId = OBJECTIVE_RECIPES[objectiveId] ? objectiveId : 'awareness';
  const rec = OBJECTIVE_RECIPES[objId];
  const market = resolveMarket(ctx);
  const usePersona = ctx.usePersona !== false;
  const ratio = ctx.ratio || '9:16';
  const subject = (ctx.persona && ctx.persona.subject) || 'person';
  const poss = subject === 'woman' ? 'her' : subject === 'man' ? 'his' : 'their';
  const hasProduct = !!(ctx.product && (ctx.product.title || ctx.product.imageUrl));
  const title = (ctx.product && ctx.product.title) || 'product';
  const mode = resolveInteraction(ctx);

  let prompt;
  if (usePersona) {
    const parts = ['The ' + subject + ' from Image 1'];
    if (hasProduct) parts.push(INTERACTIONS[mode].clause(title));
    parts.push('in ' + market.scene);
    parts.push(rec.personaAction);
    parts.push(rec.mood + ' mood');
    parts.push(rec.camera);
    parts.push('vertical ' + ratio + ' framing, photorealistic, high quality');
    prompt = parts.join(', ') + '. Keep ' + poss + ' face exactly as in Image 1' + (hasProduct ? ' and the product exactly as in Image 2' : '') + '. ' + NOTEXT;
  } else {
    const parts = ['A cinematic product showcase of the ' + title + (hasProduct ? ' from Image 2' : '')];
    parts.push('in ' + market.scene);
    parts.push(rec.productAction);
    parts.push(rec.mood + ' mood');
    parts.push(rec.camera);
    parts.push('vertical ' + ratio + ' framing, photorealistic, high quality');
    prompt = parts.join(', ') + '.' + (hasProduct ? ' Keep the product exactly as in Image 2.' : '') + ' ' + NOTEXT;
  }

  const notes = [rec.label, market.key !== 'default' ? (market.key + ' scene') : 'neutral scene', hasProduct ? (mode + ' mode') : 'no product', usePersona ? ('persona: ' + ((ctx.persona && ctx.persona.name) || subject)) : 'product-only'].join(' · ');

  return {
    objective: objId,
    label: rec.label,
    prompt: prompt,
    scene: market.scene,
    market: market.key,
    interactionMode: hasProduct ? mode : null,
    usePersona: usePersona,
    overlay: buildOverlay({ ...ctx, objective: objId }),
    notes: notes,
  };
}

// ── The composer — a funnel chain ────────────────────────────────────────────
export function buildSequence(ctx) {
  let chain = Array.isArray(ctx.objectiveChain) && ctx.objectiveChain.length ? ctx.objectiveChain : DEFAULT_CHAIN;
  chain = chain.map(function (o) { return String(o || '').toLowerCase(); }).filter(function (o) { return OBJECTIVE_RECIPES[o]; }).slice(0, MAX_CHAIN);
  if (!chain.length) chain = DEFAULT_CHAIN.slice();
  return {
    chain: chain,
    persona: (ctx.persona && ctx.persona.name) || null,
    shots: chain.map(function (objId) { return buildShot(ctx, objId); }),
  };
}

// ── Endpoint ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-clerk-session, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const action = body.action || 'shot';
    if (action === 'sequence') {
      return res.status(200).json(buildSequence(body));
    }
    const shot = buildShot(body, body.objective || 'awareness');
    return res.status(200).json({ shot: shot });
  } catch (err) {
    console.error('seq-storyboard error:', err && err.message || err);
    return res.status(500).json({ error: String((err && err.message) || 'Storyboard build failed').slice(0, 300) });
  }
}

// Expose the maps for later tuning / tests.
export { OBJECTIVE_IDS, INTERACTION_IDS, MARKETS, formatPrice };
