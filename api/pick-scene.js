// api/pick-scene.js
// ─────────────────────────────────────────────────────────────────────────────
// Scene picker for the AUTOMATED feed video flow (standalone, additive — nothing
// in generate-tiktok.js or the rich/URL flow is touched). Given a feed product, a
// fast Claude call classifies it into one of the verticals below and selects the
// best-fitting scenery, and we return that scene's rich description string. The feed
// path passes it straight into generate-tiktok's existing `scene` param, which already
// injects "the lifestyle / end environment MUST be a <scene> setting" into the storyboard.
//
// Mirrors the isolated pattern of the *-ugc / generate-meta-feed / detect-bg endpoints.
// Fail-safe: any error (or a product that fits nothing) returns { ok:false, scene:null }
// so the caller simply falls back to the generic backdrop — the video flow never breaks.
//
// Body: { product: { title, description, productType, brand }, language? }
// Returns: { ok, vertical, sceneId, sceneLabel, scene }  (scene = rich description string)
// ─────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

// Vertical → 3 scenes. `suited` steers the best-fit pick; `desc` is the rich directive
// handed to the video prompt. Edit/extend freely — the classifier reads this menu live.
const SCENE_LIBRARY = {
  fashion_apparel: { label: "Fashion & apparel", scenes: [
    { id: "warm_bedroom_wardrobe", label: "Warm bedroom wardrobe", suited: "everyday apparel, dresses, knitwear, casual tops and bottoms", desc: "a light-flooded warm bedroom with a clean wardrobe in the background, floor-to-ceiling windows and very bright natural light filling the room" },
    { id: "premium_editorial_studio", label: "Premium editorial studio", suited: "premium collections, handbags, footwear, accessories", desc: "a premium editorial studio with sculptural plinths, cream backdrops, directional studio light and subtle shadows" },
    { id: "european_street_market", label: "European street market", suited: "casualwear, streetwear, denim, seasonal fashion", desc: "a European street-market scene — city sidewalks, café terraces and a Camden-style urban market" },
  ]},
  kitchen_appliances: { label: "Kitchen appliances", scenes: [
    { id: "bright_scandi_kitchen", label: "Bright Scandinavian kitchen", suited: "blenders, coffee machines, air fryers, everyday small appliances", desc: "a bright Scandinavian kitchen with white cabinetry, pale oak, stone countertops and soft morning light" },
    { id: "premium_chef_kitchen", label: "Premium chef's kitchen", suited: "high-end espresso machines, premium appliances", desc: "a premium chef's kitchen with dark stone, elegant cabinetry, warm accent lighting and sophisticated finishes" },
    { id: "everyday_breakfast", label: "Everyday breakfast setting", suited: "coffee makers, toasters, compact cooking appliances", desc: "a lived-in kitchen breakfast setting with breakfast ingredients, a mug and gentle morning sunlight" },
  ]},
  household_equipment: { label: "Household equipment", scenes: [
    { id: "modern_living_room", label: "Modern living room", suited: "robot vacuums, cordless vacuums, floor cleaners", desc: "a modern living room with neutral furniture, clean floors and natural daylight" },
    { id: "organized_utility_room", label: "Organized utility room", suited: "garment steamers, drying equipment, dehumidifiers", desc: "an organized utility room with functional cabinetry, tiled flooring, laundry baskets and bright task lighting" },
    { id: "healthy_home", label: "Healthy home environment", suited: "air purifiers, humidifiers, indoor climate equipment", desc: "an airy, healthy home interior with greenery and uncluttered surfaces in diffused light" },
  ]},
  body_care_beauty: { label: "Body care & beauty", scenes: [
    { id: "luxury_spa_stone", label: "Luxury spa stone", suited: "skincare jars, serums, facial treatments", desc: "a luxury spa stone setting of travertine and cream surfaces with soft shadows and subtle botanical accents" },
    { id: "bathroom_vanity", label: "Contemporary bathroom vanity", suited: "cleansers, moisturizers, electric facial devices, hair tools", desc: "a contemporary bathroom vanity with marble, glass, polished fixtures and clean natural light" },
    { id: "botanical_freshness", label: "Botanical freshness", suited: "body care, botanical skincare, hair-care products", desc: "a botanical freshness scene with fresh leaves, water textures, soft green tones and diffused light" },
  ]},
  wellness: { label: "Wellness", scenes: [
    { id: "restful_bedroom", label: "Restful bedroom", suited: "sleep masks, pillows, white-noise machines, sleep accessories", desc: "a restful bedroom with linen, muted colours, warm wood and gentle morning light" },
    { id: "home_spa_retreat", label: "Home spa retreat", suited: "massage devices, heating pads, relaxation products", desc: "a home spa retreat with natural stone, folded towels, warm ambient lighting and restrained decor" },
    { id: "mindful_studio", label: "Mindful wellness studio", suited: "meditation accessories, acupressure mats, breathing devices", desc: "a mindful wellness studio with open floor space, natural textures and soft daylight" },
  ]},
  fitness_apparel: { label: "Fitness apparel", scenes: [
    { id: "premium_gym_studio", label: "Premium gym studio", suited: "leggings, sports bras, gym sets, men's training apparel", desc: "a premium gym studio with dark flooring, mirrors, steel details and directional light" },
    { id: "minimal_yoga_studio", label: "Minimal yoga studio", suited: "yoga apparel, Pilates outfits, comfortable activewear", desc: "a minimal yoga studio with neutral walls, pale wood, yoga mats and soft natural light" },
    { id: "outdoor_running", label: "Outdoor running environment", suited: "technical shirts, running jackets, compression wear", desc: "an outdoor running environment with urban running paths, park greenery and early-morning light" },
  ]},
  fitness_equipment: { label: "Fitness equipment", scenes: [
    { id: "premium_home_gym", label: "Premium home gym", suited: "dumbbells, kettlebells, benches, cable machines", desc: "a premium home gym with rubber flooring, organized weights and dark architectural details" },
    { id: "bright_workout_room", label: "Bright home workout room", suited: "walking pads, exercise bikes, resistance bands, Pilates equipment", desc: "a bright home workout room with sunlit windows, clean flooring and minimal furniture" },
    { id: "industrial_performance_gym", label: "Industrial performance gym", suited: "weighted vests, heavy equipment, strength-training products", desc: "an industrial performance gym with concrete walls, exposed steel, textured rubber floors and focused lighting" },
  ]},
  diy_outdoor: { label: "DIY — outdoor", scenes: [
    { id: "residential_garden", label: "Manicured residential garden", suited: "lawn mowers, hedge trimmers, leaf blowers", desc: "a manicured residential garden with a green lawn, clean hedges and contemporary architecture" },
    { id: "outdoor_workshop", label: "Outdoor DIY workshop", suited: "power tools, tool kits, garden equipment", desc: "an outdoor DIY workshop with a wooden workbench, garden shed, practical storage and natural light" },
    { id: "patio_maintenance", label: "Patio maintenance scene", suited: "pressure washers, deck-cleaning tools", desc: "a patio maintenance scene with stone paving, garden paths, outdoor surfaces and visible cleaning context" },
  ]},
  diy_indoor: { label: "DIY — indoor", scenes: [
    { id: "home_workshop", label: "Organized home workshop", suited: "drills, sanders, workshop accessories", desc: "an organized home workshop with pegboards, a solid workbench, tool storage and neutral industrial materials" },
    { id: "home_renovation", label: "Home renovation setting", suited: "measuring tools, painting kits, wall-mounting products", desc: "a home renovation setting with unfinished walls, ladders, protective sheets and work lighting" },
    { id: "modern_garage", label: "Modern garage workspace", suited: "storage systems, power tools, dust extraction equipment", desc: "a modern garage workspace with modular cabinets, concrete floors and organized tools" },
  ]},
  home_decor: { label: "Home decor", scenes: [
    { id: "scandi_living_room", label: "Scandinavian living room", suited: "cushions, vases, throws, decorative objects", desc: "a Scandinavian living room with pale oak, textured fabrics, ceramics and neutral tones" },
    { id: "mediterranean_warmth", label: "Mediterranean warmth", suited: "ceramics, wall art, warm-toned decorative products", desc: "a Mediterranean-warmth interior with terracotta, textured plaster, natural linen and sunlit surfaces" },
    { id: "contemporary_design_interior", label: "Contemporary design interior", suited: "decorative accessories, statement styling", desc: "a contemporary design interior with carefully styled shelving, art, statement mirrors and contrasting colours" },
  ]},
  furniture: { label: "Furniture", scenes: [
    { id: "scandi_living_space", label: "Scandinavian living space", suited: "sofas, dining chairs, sideboards, shelving", desc: "a Scandinavian living space with spacious rooms, natural wood, neutral upholstery and soft daylight" },
    { id: "premium_contemporary_interior", label: "Premium contemporary interior", suited: "premium sofas, statement furniture, designer tables", desc: "a premium contemporary interior with marble accents, sophisticated materials and layered lighting" },
    { id: "modern_home_office", label: "Modern home office", suited: "office furniture, compact storage solutions", desc: "a modern home office with a desk, ergonomic chair, practical storage and clean architectural lines" },
  ]},
  lighting: { label: "Lighting", scenes: [
    { id: "warm_evening_interior", label: "Warm evening interior", suited: "table lamps, floor lamps, ambient lighting", desc: "a warm evening interior — a softly lit living room with warm surfaces and subtle shadows" },
    { id: "architectural_pendant", label: "Architectural pendant setting", suited: "pendant lights, ceiling fixtures", desc: "an architectural pendant setting over a kitchen island or dining table with clean lines and strong geometry" },
    { id: "ambient_smart_light", label: "Ambient smart-light environment", suited: "LED strips, smart bulbs, connected lighting systems", desc: "an ambient smart-light environment with indirect illumination, subtle colour gradients and a contemporary interior" },
  ]},
  garden_equipment: { label: "Garden equipment", scenes: [
    { id: "landscaped_garden", label: "Lush landscaped garden", suited: "robotic mowers, garden tools, watering systems", desc: "a lush landscaped garden with lawn, flower beds, hedges and natural daylight" },
    { id: "vegetable_garden", label: "Productive vegetable garden", suited: "planters, greenhouses, composters, watering kits", desc: "a productive vegetable garden with raised beds, seedlings, greenhouse panels and irrigation details" },
    { id: "contemporary_outdoor_living", label: "Contemporary outdoor living", suited: "storage sheds, hose reels, premium garden equipment", desc: "a contemporary outdoor-living scene with decking, ornamental grasses, clean garden storage and landscaped surroundings" },
  ]},
};

function resolveScene(verticalKey, sceneId) {
  const v = SCENE_LIBRARY[verticalKey];
  if (!v) return null;
  const s = (v.scenes || []).find((x) => x.id === sceneId) || null;
  if (!s) return null;
  return { vertical: v.label, sceneId: s.id, sceneLabel: s.label, scene: s.desc };
}

function buildMenu() {
  return Object.entries(SCENE_LIBRARY).map(([key, v]) => {
    const lines = v.scenes.map((s) => `    - ${s.id} (best for ${s.suited})`).join("\n");
    return `• ${key} — ${v.label}\n${lines}`;
  }).join("\n");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const product = (req.body && req.body.product) || {};
  const title = (product.title || "").slice(0, 300);
  const productType = (product.productType || "").slice(0, 160);
  const description = (product.description || "").slice(0, 600);
  const brand = (product.brand || "").slice(0, 120);

  // Fail-safe default — caller treats scene:null as "use the generic backdrop".
  const FALLBACK = { ok: false, scene: null };
  if (!apiKey || (!title && !productType && !description)) return res.status(200).json(FALLBACK);

  const prompt = `You are a creative director choosing the ideal filming environment for a short product video.
Pick the single best-fitting VERTICAL and, within it, the SCENE whose "best for" most closely matches THIS product.
Product categories may be written in another language (e.g. Danish) — infer the meaning. If nothing fits well, choose the closest.

PRODUCT
- Title: ${title || "(none)"}
- Category (from feed): ${productType || "(none)"}
- Description: ${description || "(none)"}
- Brand: ${brand || "(none)"}

MENU (choose one vertical key, then one scene id from inside that same vertical)
${buildMenu()}

Return ONLY valid JSON, no markdown:
{ "vertical": "<vertical key>", "scene": "<scene id>" }`;

  try {
    const claudeRes = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 120, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await claudeRes.json();
    const raw = data.content?.[0]?.text || "";
    if (!raw) return res.status(200).json(FALLBACK);
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    const resolved = resolveScene(parsed.vertical, parsed.scene);
    if (!resolved) return res.status(200).json(FALLBACK);
    return res.status(200).json({ ok: true, ...resolved });
  } catch (e) {
    return res.status(200).json({ ok: false, scene: null, error: String((e && e.message) || e) });
  }
}

export { SCENE_LIBRARY, resolveScene };
