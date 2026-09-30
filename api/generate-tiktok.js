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

  // ── Creative Studio TEMPLATES — Beauty & Personal Care (narrative scaffolds) ──
  beauty_morning_ritual: {
    label: "White → Morning Ritual",
    instructions: `- Video storyboard: 4 scenes — the "White → Morning Ritual" beauty template. A calm morning-ritual arc: the product begins on clean white, a soft bathroom/bedroom materialises, a person picks it up and applies/uses it, ending on a confident lifestyle beat.
  Scene 1 (0-2s): Product alone on a bright clean white background, soft even light, slow push-in.
  Scene 2 (2-5s): The white gently gives way as a serene bathroom or sunlit bedroom vanity materialises softly around the product.
  Scene 3 (5-8s): A person's hands pick up the product and apply/use it naturally — gentle, real, close and warm.
  Scene 4 (8-10s): Confident lifestyle beat — the person looking fresh and self-assured, product resting nearby.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-2s", "title": "Clean White", "description": "Product on bright white, soft light, slow push-in" },
    { "scene": 2, "timing": "2-5s", "title": "Morning Space", "description": "A serene bathroom/bedroom vanity materialises softly around the product" },
    { "scene": 3, "timing": "5-8s", "title": "The Ritual", "description": "Hands pick up and apply/use the product, warm and natural" },
    { "scene": 4, "timing": "8-10s", "title": "Confident Close", "description": "Fresh, self-assured lifestyle beat, product nearby" }
  ]`,
  },
  beauty_ingredient_transformation: {
    label: "Ingredient → Transformation",
    instructions: `- Video storyboard: 3 scenes — the "Ingredient → Transformation" beauty template. Natural ingredients visually appear and flow into the product, transitioning into use and a skin/hair result-focused lifestyle scene.
  Scene 1 (0-3s): Product with its key natural ingredients drifting/appearing around it — botanicals, droplets, textures — elegant and fresh.
  Scene 2 (3-7s): The ingredients visually flow into or merge with the product, then transition into a moment of use on skin or hair.
  Scene 3 (7-10s): Result-focused lifestyle close — glowing skin or healthy hair, the person radiant, product featured.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-3s", "title": "Ingredients Appear", "description": "Key natural ingredients drift and appear around the product" },
    { "scene": 2, "timing": "3-7s", "title": "Transformation", "description": "Ingredients merge into the product, transition into use on skin/hair" },
    { "scene": 3, "timing": "7-10s", "title": "The Result", "description": "Glowing skin/healthy hair, radiant lifestyle close, product featured" }
  ]`,
  },
  beauty_luxury_reveal: {
    label: "Luxury Reveal",
    instructions: `- Video storyboard: 3 scenes — the "Luxury Reveal" beauty template. A cinematic packshot in an elegant bathroom/vanity, with refined camera movement, the product becoming a hero object.
  Scene 1 (0-3s): Elegant packshot of the product, premium lighting, dark or marble luxurious backdrop, slow reveal.
  Scene 2 (3-7s): Cinematic camera movement through an elegant bathroom or vanity setting, the product presented like a jewel.
  Scene 3 (7-10s): The product settles as the hero object, gleaming, aspirational and premium, gentle pull-back.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-3s", "title": "Elegant Packshot", "description": "Premium packshot, luxurious backdrop, slow reveal" },
    { "scene": 2, "timing": "3-7s", "title": "Cinematic Vanity", "description": "Refined camera movement through an elegant bathroom/vanity" },
    { "scene": 3, "timing": "7-10s", "title": "Hero Object", "description": "Product settles gleaming as the premium hero, gentle pull-back" }
  ]`,
  },
  beauty_before_the_day: {
    label: "Before the Day Starts",
    instructions: `- Video storyboard: 4 scenes — the "Before the Day Starts" beauty template. A morning-getting-ready arc: product in a morning environment, a person uses it, gets ready, and leaves home confident.
  Scene 1 (0-2s): Product in a bright morning environment — a sunlit bathroom shelf or bedroom, calm and fresh.
  Scene 2 (2-5s): A person reaches for and uses the product as part of getting ready, natural and unhurried.
  Scene 3 (5-8s): The person finishing their morning routine, looking polished and ready.
  Scene 4 (8-10s): Confident departure — stepping out into the day, self-assured.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-2s", "title": "Morning Light", "description": "Product in a bright, calm morning environment" },
    { "scene": 2, "timing": "2-5s", "title": "Getting Ready", "description": "Person uses the product while getting ready, natural" },
    { "scene": 3, "timing": "5-8s", "title": "Polished", "description": "Finishing the routine, looking ready" },
    { "scene": 4, "timing": "8-10s", "title": "Into the Day", "description": "Confident departure, stepping out self-assured" }
  ]`,
  },
  beauty_problem_solution: {
    label: "Problem → Solution",
    instructions: `- Video storyboard: 4 scenes — the "Problem → Solution" beauty template. A visual representation of a concern, the product entering the scene, usage, and a positive result. Keep the "problem" tasteful and visual (never clinical or negative text).
  Scene 1 (0-2s): A gentle, tasteful visual suggestion of the concern the product addresses (e.g. dull skin in soft light) — subtle, not harsh.
  Scene 2 (2-4s): The product enters the scene cleanly, presented as the answer.
  Scene 3 (4-8s): The product is applied/used, a soft transition suggesting improvement.
  Scene 4 (8-10s): Positive result — visibly better skin/hair, the person confident and happy, product featured.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-2s", "title": "The Concern", "description": "Tasteful visual suggestion of the concern, subtle and soft" },
    { "scene": 2, "timing": "2-4s", "title": "Product Enters", "description": "Product enters the scene cleanly as the answer" },
    { "scene": 3, "timing": "4-8s", "title": "In Use", "description": "Product applied/used, soft transition suggesting improvement" },
    { "scene": 4, "timing": "8-10s", "title": "Positive Result", "description": "Visibly better result, person confident and happy, product featured" }
  ]`,
  },

  // ── Creative Studio TEMPLATES — Fashion & Apparel ──
  fashion_flatlay_model: {
    label: "Flat Lay → Model",
    instructions: `- Video storyboard: 4 scenes — "Flat Lay → Model". A styled flat-lay of the garment, the environment forms around it, the garment appears worn on a model, and the model moves.
  Scene 1 (0-2s): Elegant flat-lay of the garment on a clean styled surface, soft overhead light, slow push-in.
  Scene 2 (2-4s): The environment forms around it — a studio or lifestyle backdrop materialises.
  Scene 3 (4-7s): The garment appears worn on a model, natural pose, flattering light.
  Scene 4 (7-10s): The model moves — a turn, a walk, fabric in motion — confident editorial close.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-2s", "title": "Flat Lay", "description": "Styled flat-lay of the garment, soft overhead light, push-in" },
    { "scene": 2, "timing": "2-4s", "title": "Environment Forms", "description": "A studio/lifestyle backdrop materialises around it" },
    { "scene": 3, "timing": "4-7s", "title": "On Model", "description": "Garment appears worn on a model, natural pose, flattering light" },
    { "scene": 4, "timing": "7-10s", "title": "In Motion", "description": "Model moves, fabric in motion, editorial close" }
  ]`,
  },
  fashion_outfit_transformation: {
    label: "Outfit Transformation",
    instructions: `- Video storyboard: 3 scenes — "Outfit Transformation". The hero item stays constant while the outfit around it changes, ending on a final complete look.
  Scene 1 (0-3s): Person wearing the hero item, clean neutral setting, the item clearly featured.
  Scene 2 (3-7s): The rest of the outfit visually changes/styles around the constant hero item — accessories, layers shifting.
  Scene 3 (7-10s): The final complete look, confident and polished, hero item central.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-3s", "title": "Hero Item", "description": "Person wearing the hero item, clean setting, item featured" },
    { "scene": 2, "timing": "3-7s", "title": "Styling Shift", "description": "Outfit changes around the constant hero item" },
    { "scene": 3, "timing": "7-10s", "title": "Final Look", "description": "Complete polished look, hero item central" }
  ]`,
  },
  fashion_wardrobe_lifestyle: {
    label: "Wardrobe → Lifestyle",
    instructions: `- Video storyboard: 4 scenes — "Wardrobe → Lifestyle". Garment in a wardrobe/bedroom, person gets dressed, leaves, into a lifestyle scene.
  Scene 1 (0-2s): The garment in a stylish wardrobe or on a bedroom rail, soft morning light.
  Scene 2 (2-5s): A person selects and puts on the garment, natural getting-dressed moment.
  Scene 3 (5-8s): Dressed and ready, a confident mirror or doorway beat.
  Scene 4 (8-10s): Out into a lifestyle scene — street, café, city — wearing the look.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-2s", "title": "In the Wardrobe", "description": "Garment in a stylish wardrobe/bedroom, soft light" },
    { "scene": 2, "timing": "2-5s", "title": "Getting Dressed", "description": "Person selects and puts on the garment" },
    { "scene": 3, "timing": "5-8s", "title": "Ready", "description": "Dressed, confident mirror/doorway beat" },
    { "scene": 4, "timing": "8-10s", "title": "Lifestyle", "description": "Out into a lifestyle scene wearing the look" }
  ]`,
  },
  fashion_street_style: {
    label: "Street Style",
    instructions: `- Video storyboard: 3 scenes — "Street Style". Product to a city environment, a model appears, walking/editorial shots.
  Scene 1 (0-3s): The garment featured, then a city environment builds around it — urban textures, daylight.
  Scene 2 (3-7s): A model appears wearing it, walking through the street, dynamic and editorial.
  Scene 3 (7-10s): Confident editorial close — a pause, a look, the garment the focus.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-3s", "title": "City Builds", "description": "Garment featured, urban environment forms around it" },
    { "scene": 2, "timing": "3-7s", "title": "Walking", "description": "Model walks through the street, dynamic editorial" },
    { "scene": 3, "timing": "7-10s", "title": "Editorial Close", "description": "Confident pause, garment the focus" }
  ]`,
  },
  fashion_day_to_night: {
    label: "Day → Night",
    instructions: `- Video storyboard: 3 scenes — "Day → Night". The same piece styled for day, then the environment/time shifts to an evening version.
  Scene 1 (0-3s): Daytime look with the garment, bright natural setting, casual confidence.
  Scene 2 (3-6s): The environment and light transition from day to dusk to night.
  Scene 3 (6-10s): The evening version of the look, elevated styling, glamorous night setting.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-3s", "title": "Day Look", "description": "Daytime styling, bright natural setting" },
    { "scene": 2, "timing": "3-6s", "title": "Transition", "description": "Environment/light shifts day to dusk to night" },
    { "scene": 3, "timing": "6-10s", "title": "Night Look", "description": "Evening version, elevated styling, glamorous setting" }
  ]`,
  },
  fashion_one_piece_three_looks: {
    label: "One Piece / Three Looks",
    instructions: `- Video storyboard: 4 scenes — "One Piece / Three Looks". One hero piece shown three ways with quick transitions.
  Scene 1 (0-2s): The hero piece introduced clearly on a model.
  Scene 2 (2-5s): Look 1 — styled one way; quick stylish transition.
  Scene 3 (5-8s): Look 2 — styled a second way; quick transition.
  Scene 4 (8-10s): Look 3 — styled a third way, confident final beat, same piece throughout.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-2s", "title": "The Piece", "description": "Hero piece introduced on a model" },
    { "scene": 2, "timing": "2-5s", "title": "Look 1", "description": "Styled one way, quick transition" },
    { "scene": 3, "timing": "5-8s", "title": "Look 2", "description": "Styled a second way, quick transition" },
    { "scene": 4, "timing": "8-10s", "title": "Look 3", "description": "Styled a third way, confident final beat" }
  ]`,
  },

  // ── Creative Studio TEMPLATES — Home Decor & Interior Design ──
  homedecor_product_room: {
    label: "Product → Room",
    instructions: `- Video storyboard: 3 scenes — "Product → Room". Product on white, a room materialises around it, the product settles naturally into place.
  Scene 1 (0-3s): The product alone on clean white, soft even light, slow push-in.
  Scene 2 (3-7s): A stylish room materialises softly around the product — walls, light, complementary furnishings forming.
  Scene 3 (7-10s): The product settles naturally into its place in the finished room, warm and inviting.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-3s", "title": "Clean White", "description": "Product alone on white, soft light, push-in" },
    { "scene": 2, "timing": "3-7s", "title": "Room Forms", "description": "A stylish room materialises softly around the product" },
    { "scene": 3, "timing": "7-10s", "title": "In Place", "description": "Product settles naturally into the finished room" }
  ]`,
  },
  homedecor_empty_designed: {
    label: "Empty → Designed",
    instructions: `- Video storyboard: 4 scenes — "Empty → Designed". An empty room, the hero product appears, additional furniture/decor accumulates, ending on a finished interior.
  Scene 1 (0-2s): An empty, bare room with good natural light and potential.
  Scene 2 (2-4s): The hero product appears as the anchor of the space.
  Scene 3 (4-8s): Additional furniture and decor appear around it, the room filling in tastefully.
  Scene 4 (8-10s): The finished, fully-designed interior, the hero product central.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-2s", "title": "Empty Room", "description": "Bare room, good natural light, potential" },
    { "scene": 2, "timing": "2-4s", "title": "Hero Appears", "description": "The hero product appears as the anchor" },
    { "scene": 3, "timing": "4-8s", "title": "Filling In", "description": "Furniture and decor accumulate tastefully" },
    { "scene": 4, "timing": "8-10s", "title": "Designed", "description": "Finished interior, hero product central" }
  ]`,
  },
  homedecor_before_after: {
    label: "Before → After",
    instructions: `- Video storyboard: 3 scenes — "Before → After". A plain interior, the hero product is introduced, a complete transformation follows.
  Scene 1 (0-3s): A plain, uninspiring interior — flat, ordinary.
  Scene 2 (3-6s): The hero product is introduced into the space, a turning point.
  Scene 3 (6-10s): The complete transformation — the same space now beautiful and elevated, product central.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-3s", "title": "Before", "description": "Plain, ordinary interior" },
    { "scene": 2, "timing": "3-6s", "title": "Product Enters", "description": "Hero product introduced, a turning point" },
    { "scene": 3, "timing": "6-10s", "title": "After", "description": "Space transformed, beautiful and elevated, product central" }
  ]`,
  },
  homedecor_room_tour: {
    label: "Room Tour",
    instructions: `- Video storyboard: 3 scenes — "Room Tour". Start on the product, the camera pulls back to reveal the whole room, then detail shots.
  Scene 1 (0-3s): Close on the product, beautifully lit in its setting.
  Scene 2 (3-7s): The camera pulls back smoothly to reveal the entire styled room around it.
  Scene 3 (7-10s): A few elegant detail shots — textures, the product's role in the space.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-3s", "title": "Close Up", "description": "Close on the product, beautifully lit" },
    { "scene": 2, "timing": "3-7s", "title": "Pull Back", "description": "Camera pulls back to reveal the whole styled room" },
    { "scene": 3, "timing": "7-10s", "title": "Details", "description": "Elegant detail shots, textures, product's role" }
  ]`,
  },
  homedecor_mood_transformation: {
    label: "Mood Transformation",
    instructions: `- Video storyboard: 3 scenes — "Mood Transformation". The product anchors a room as the mood shifts from minimal to a richer style (cozy/luxury/modern).
  Scene 1 (0-3s): The product in a minimal, pared-back version of the room.
  Scene 2 (3-6s): The mood transforms — lighting, textures and styling shift toward cozy/luxury/modern.
  Scene 3 (6-10s): The fully realised richer mood, the product perfectly at home in it.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-3s", "title": "Minimal", "description": "Product in a pared-back version of the room" },
    { "scene": 2, "timing": "3-6s", "title": "Mood Shifts", "description": "Lighting, textures, styling shift richer" },
    { "scene": 3, "timing": "6-10s", "title": "Realised", "description": "Fully realised mood, product at home in it" }
  ]`,
  },
  homedecor_product_in_context: {
    label: "Product in Context",
    instructions: `- Video storyboard: 4 scenes — "Product in Context". The product shown across several different rooms to demonstrate versatility.
  Scene 1 (0-2s): The product introduced cleanly.
  Scene 2 (2-5s): The product in a first room/style setting.
  Scene 3 (5-8s): A smooth transition to the product in a second, different room/style.
  Scene 4 (8-10s): A third setting, reinforcing versatility, confident close.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-2s", "title": "Introduced", "description": "Product introduced cleanly" },
    { "scene": 2, "timing": "2-5s", "title": "Setting 1", "description": "Product in a first room/style" },
    { "scene": 3, "timing": "5-8s", "title": "Setting 2", "description": "Transition to a second, different room/style" },
    { "scene": 4, "timing": "8-10s", "title": "Setting 3", "description": "A third setting, versatility, confident close" }
  ]`,
  },

  // ── Creative Studio TEMPLATES — Fitness & Wellness ──
  fitness_workout_activation: {
    label: "Product → Workout Activation",
    instructions: `- Video storyboard: 4 scenes — "Workout Activation". Product on white, a gym/home workout environment materialises, a person picks up/uses the product, the workout begins with energetic action, product hero close.
  Scene 1 (0-2s): Product on clean white, crisp light, slow push-in.
  Scene 2 (2-4s): A gym or home-workout environment materialises around it.
  Scene 3 (4-7s): A person picks up/uses the product and the workout begins — energetic, dynamic action.
  Scene 4 (7-10s): Peak energetic moment, then a strong product hero close.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-2s", "title": "Clean White", "description": "Product on white, crisp light, push-in" },
    { "scene": 2, "timing": "2-4s", "title": "Environment", "description": "Gym/home-workout environment materialises" },
    { "scene": 3, "timing": "4-7s", "title": "Activation", "description": "Person uses product, workout begins, dynamic action" },
    { "scene": 4, "timing": "7-10s", "title": "Hero Close", "description": "Peak energy, strong product hero close" }
  ]`,
  },
  fitness_morning_wellness: {
    label: "Product → Morning Wellness Routine",
    instructions: `- Video storyboard: 4 scenes — "Morning Wellness Routine". Product in a morning environment, preparation, consumption/use, an active day begins, product hero.
  Scene 1 (0-2s): Product in a bright, calm morning environment.
  Scene 2 (2-5s): Preparation — the product readied or mixed, natural and healthy.
  Scene 3 (5-8s): Consumption/use, then the person stepping into an active, energised day.
  Scene 4 (8-10s): Product hero close, fresh and wellness-focused.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-2s", "title": "Morning", "description": "Product in a bright calm morning environment" },
    { "scene": 2, "timing": "2-5s", "title": "Preparation", "description": "Product readied/mixed, natural and healthy" },
    { "scene": 3, "timing": "5-8s", "title": "Active Day", "description": "Consumption/use, stepping into an energised day" },
    { "scene": 4, "timing": "8-10s", "title": "Hero Close", "description": "Fresh, wellness-focused product hero close" }
  ]`,
  },
  fitness_performance_transformation: {
    label: "Product → Performance Transformation",
    instructions: `- Video storyboard: 4 scenes — "Performance Transformation". Product on white, a person/environment appears, product used, physical activity intensifies to a performance moment, product hero.
  Scene 1 (0-2s): Product on white, powerful clean light.
  Scene 2 (2-4s): A person and an athletic environment appear.
  Scene 3 (4-7s): The product is used and physical activity intensifies — building effort and power.
  Scene 4 (7-10s): A peak performance moment, then product hero close.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-2s", "title": "Clean White", "description": "Product on white, powerful clean light" },
    { "scene": 2, "timing": "2-4s", "title": "Athlete Appears", "description": "A person and athletic environment appear" },
    { "scene": 3, "timing": "4-7s", "title": "Intensifies", "description": "Product used, activity intensifies, building power" },
    { "scene": 4, "timing": "7-10s", "title": "Peak + Hero", "description": "Peak performance moment, product hero close" }
  ]`,
  },
  fitness_activity_recovery: {
    label: "Product → Activity → Recovery",
    instructions: `- Video storyboard: 4 scenes — "Activity → Recovery". Best for equipment, protein, recovery and functional products. Product, into activity/effort, then a restorative recovery moment, product hero.
  Scene 1 (0-2s): Product introduced cleanly, energetic tone.
  Scene 2 (2-5s): Into activity/effort — the product used during exertion, dynamic.
  Scene 3 (5-8s): The shift to recovery — a calm, restorative moment (stretch, rest, replenish).
  Scene 4 (8-10s): Restored and refreshed, product hero close.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-2s", "title": "Introduced", "description": "Product introduced cleanly, energetic tone" },
    { "scene": 2, "timing": "2-5s", "title": "Activity", "description": "Product used during exertion, dynamic" },
    { "scene": 3, "timing": "5-8s", "title": "Recovery", "description": "Shift to a calm restorative moment" },
    { "scene": 4, "timing": "8-10s", "title": "Hero Close", "description": "Restored and refreshed, product hero close" }
  ]`,
  },
  fitness_lifestyle_transformation: {
    label: "Product → Lifestyle Transformation",
    instructions: `- Video storyboard: 4 scenes — "Lifestyle Transformation". Product on white, an ordinary environment, the product enters the routine, activity, a healthy/social lifestyle, product hero.
  Scene 1 (0-2s): Product on clean white.
  Scene 2 (2-4s): An ordinary everyday environment.
  Scene 3 (4-7s): The product enters the routine and activity follows — movement, energy.
  Scene 4 (7-10s): A healthy, social lifestyle beat, then product hero close.`,
    json: `"storyboard": [
    { "scene": 1, "timing": "0-2s", "title": "Clean White", "description": "Product on clean white" },
    { "scene": 2, "timing": "2-4s", "title": "Everyday", "description": "An ordinary everyday environment" },
    { "scene": 3, "timing": "4-7s", "title": "Enters Routine", "description": "Product enters the routine, activity follows" },
    { "scene": 4, "timing": "7-10s", "title": "Healthy Life", "description": "Healthy social lifestyle beat, product hero close" }
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
