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

  const { url, language = "English", imageModel = "dalle", isPro = false, audienceBrief = null, keywords = [] } = req.body || {};
  if (!url) return res.status(400).json({ error: "url is required" });

  // ── Step 1: Scrape the URL ────────────────────────────────────────────────
  let pageContent = "";
  let scrapeImages = [];
  try {
    const scrapeRes = await fetch(`${req.headers.origin || "https://" + req.headers.host}/api/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const scrapeData = await scrapeRes.json();
    pageContent = scrapeData.content || scrapeData.text || "";
    scrapeImages = scrapeData.images || [];
  } catch (e) {
    pageContent = url; // fallback to URL only
  }

  // ── Smart image selection — works for both product and category URLs ──────────
  // Expanded URL patterns for product pages across many platforms/languages
  const isProductUrl = /\/p-|\/product|\/produkt|\/pd\/|\/item\/|\/p\/|[a-f0-9]{8}-[a-f0-9]{4}|\.html|\.htm|\?.*color=|\?.*variant|itemid=|productid=/i.test(url);

  // Score images by how likely they are to be product photos
  // Product images: usually from CDN, contain product IDs, are square/portrait
  const scoreImage = (img) => {
    let score = 0;
    if (/cdn|media|product|static|assets|img|image/i.test(img)) score += 2;
    if (/\/products?\/|\/items?\/|\/catalog/i.test(img)) score += 3;
    if (/\/uploads\//i.test(img)) score += 2; // WooCommerce/WordPress uploads
    if (/\/thumbnails?\//i.test(img)) score += 5; // Shopify product thumbnails — high priority
    if (/[0-9]{4,}/.test(img)) score += 1; // has numeric ID
    if (/\d+x\d+/i.test(img)) score += 3; // has dimensions like 1200x1200
    if (/(1200x1200|800x800|600x600|1000x1000)/i.test(img)) score += 3; // square product shots
    if (/(_main|_hero|_primary|_front|_pdp|_full)/i.test(img)) score += 5; // PDP hero patterns
    if (/\.jpg|\.jpeg|\.webp|\.png/i.test(img)) score += 1;
    // Boost large editorial/collage images for category/general pages
    if (/collage|editorial|campaign|hero|cover|feature|banner-img|header-img|splash/i.test(img)) score += 4;
    if (/1920|1600|1440|1280|1200x[4-9]/i.test(img)) score += 3; // wide landscape dimensions = hero image
    // Penalise small icons and UI elements
    if (/logo|icon|sprite|membership|plus|exclusive|mobil|vektor/i.test(img)) score -= 5;
    if (/news|article|blog|post|author|avatar|profile|press/i.test(img)) score -= 8; // editorial content
    if (/splash|popup|modal|promo-|announcement/i.test(img)) score -= 6; // marketing overlays
    if (/\/flags?\/|\/flag-|\/emoji|\/social|\/share|\/arrow|\/star|\/check/i.test(img)) score -= 8; // flag icons, social icons
    if (/[_-](16|24|32|48|64|96|128|180)x\1|_(sm|xs|tiny|mini|thumb16|thumb32)/i.test(img)) score -= 6; // small fixed sizes
    if (/cart\/|widget|badge|shipping|delivery|frifreight|pricerunner|trustpilot|review|rating|payment|klarna|mobilepay|paypal|visa|mastercard/i.test(img)) score -= 10;
    if (img.length < 40) score -= 3;
    if (/%7B|\{width\}|\{height\}/i.test(img)) score -= 20; // Shopify responsive template — not a real URL
    if (/\{width\}|\{height\}|\{size\}/i.test(img)) score -= 20; // Shopify responsive template — not a real URL
    return score;
  };

  // ── Shopify: derive additional product images from hero URL ──────────────────
  // Shopify stores multiple product shots at the same CDN path with different timestamps
  // Pattern: /products/{id}/thumbnails/{name}-{timestamp}.{ext}
  const shopifyExtraImages = [];
  if (scrapeImages.length > 0) {
    const heroUrl = scrapeImages[0];
    const shopifyMatch = heroUrl.match(/^(https?:\/\/[^\/]+\/products?\/[0-9]+\/(?:thumbnails?\/)?)(.*?)(-[0-9]{10,})(\.[a-z]+)$/i);
    if (shopifyMatch) {
      // Look for other images from same product folder in scraped images
      const productBase = shopifyMatch[1];
      const productImages = scrapeImages.filter(img => img.includes(productBase) && img !== heroUrl);
      shopifyExtraImages.push(...productImages.slice(0, 3));
    }
  }

  // Sort scraped images by product likelihood score
  const scoredImages = [...new Set([...scrapeImages, ...shopifyExtraImages])]
    .map(img => ({ img, score: scoreImage(img) }))
    .sort((a, b) => b.score - a.score)
    .filter(x => x.score > 0)
    .map(x => x.img);

  const heroProductImage = scoredImages[0] || scrapeImages[0] || null;
  const isSingleProduct = isProductUrl || scrapeImages.length <= 6;

  // ── Shopify JSON API: fetch product images directly ────────────────────────────
  // Always try for Shopify URLs — bypasses HTML scraping limitations
  const isShopifyUrl = /\/products?\/[^\/]+(-[a-z0-9]+)*\.(html?)?$|\/collections\/|\.myshopify\.com/i.test(url) ||
    scrapeImages.some(img => /cdn\.shopify\.com|\.myshopify\.com/i.test(img));
  if (isShopifyUrl || scoredImages.length < 3) {
    try {
      const shopifyJsonUrl = url.split('?')[0].replace(/\/$/, '') + '.json';
      const sjRes = await fetch(shopifyJsonUrl, { 
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      });
      if (sjRes.ok) {
        const sjData = await sjRes.json();
        const productImages = (sjData.product?.images || [])
          .map(img => img.src)
          .filter(src => src && src.startsWith('http'));
        for (const img of productImages) {
          if (!scoredImages.includes(img)) scoredImages.push(img);
        }
      }
    } catch(_) {}
  }

  // Re-sort after potential Shopify additions
  scoredImages.sort((a, b) => scoreImage(b) - scoreImage(a));

  // ── Secondary scraped images — deduplicated by filename, prefer full-size ──────
  // Hard blocklist — never show these regardless of score
  const BLOCKED = /cart\/|frifreight|widget|badge|trustpilot|pricerunner|klarna|mobilepay|paypal|visa|mastercard|shipping|delivery|free.*ship|payment|%7B|\{width\}|\{height\}|_logo\.|logo_|logo-|\/logo/i;
  const cleanScored = scoredImages.filter(img => !BLOCKED.test(img));

  const heroFilename = heroProductImage ? heroProductImage.split('/').pop().split('?')[0] : null;
  const seenFilenames = new Set(heroFilename ? [heroFilename] : []);
  const uniqueScored = cleanScored.filter(img => {
    const filename = img.split('/').pop().split('?')[0];
    if (seenFilenames.has(filename)) return false;
    seenFilenames.add(filename);
    // Prefer full-size over thumbnail variants
    const isThumb = /\/thumbnails?\//i.test(img);
    const fullSizeExists = scoredImages.some(other =>
      other !== img &&
      other.split('/').pop().split('?')[0] === filename &&
      !/\/thumbnails?\//i.test(other)
    );
    return !(isThumb && fullSizeExists);
  });
  const secondaryImage = uniqueScored[0] || null;
  const tertiaryImage  = uniqueScored[1] || null;

  // ── Homepage editorial image ──────────────────────────────────────────────────
  let homepageImage = null;
  if (heroProductImage) {
    try {
      const domain = new URL(url).origin;
      const homeRes = await fetch(`${req.headers.origin || 'https://' + req.headers.host}/api/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: domain }),
      });
      const homeData = await homeRes.json();
      const homeImages = homeData.images || [];
      // Find a homepage image that's different from the product image and reasonably sized
      // Filter out tiny icons, logos (usually < 200 chars in URL) and the hero image itself
      const candidates = homeImages.filter(img =>
        img !== heroProductImage &&
        !img.includes('logo') &&
        !img.includes('icon') &&
        !img.includes('banner') &&
        img.length > 30
      );
      homepageImage = candidates[0] || null;
    } catch(_) {}
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
  "imagePrompt": "Detailed prompt for a 1:1 Meta ad image — photorealistic, clean composition, no text overlays, no logos.${modelHint} Show the product in a lifestyle setting relevant to the brand. Suitable for Facebook/Instagram feed."
}

${keywords && keywords.length > 0 ? `
Focus keywords to include in copy: ${keywords.join(', ')}` : ''}
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
    if (!raw) {
      const errMsg = claudeData.error?.message || JSON.stringify(claudeData);
      return res.status(500).json({ error: "Copy generation failed", detail: errMsg });
    }
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
      // ── Dynamic category detection via Claude ─────────────────────────────
      let sceneContext  = 'modern lifestyle setting';
      let sceneObjects  = 'minimal contemporary props and clean geometric elements';
      let sceneLocation = 'a clean modern surface';

      try {
        const categoryRes = await fetch(ANTHROPIC_API, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            messages: [{
              role: 'user',
              content: `You are a product category classifier for an ad creative tool. Based on this URL and page content, identify the product category and suggest an ideal lifestyle photography scene for a Meta ad image.\n\nURL: ${url}\nPage content (first 500 chars): ${pageContent.slice(0, 500)}\n\nReturn ONLY valid JSON:\n{\n  "sceneContext": "brief setting description",\n  "sceneObjects": "3-5 props that belong in this scene (no product packaging)",\n  "sceneLocation": "specific surface or location"\n}\n\nExamples:\n- Tires/Auto: garage with car keys and tools on workshop bench\n- Skincare: marble vanity with botanical ingredients and soft towels\n- Fashion: urban street or clean studio with fabric textures\n- Food: kitchen counter with fresh ingredients and wooden boards\n- Tech: minimal desk with ambient lighting and clean accessories\n- Sports: gym or outdoor track with equipment and natural light\n\nBe specific and visual. Never use botanicals or natural elements for non-skincare products.`
            }]
          })
        });
        const catData = await categoryRes.json();
        const catText = catData.content?.[0]?.text || '';
        const catClean = catText.replace(/```json|```/g, '').trim();
        const catParsed = JSON.parse(catClean);
        if (catParsed.sceneContext) sceneContext = catParsed.sceneContext;
        if (catParsed.sceneObjects) sceneObjects = catParsed.sceneObjects;
        if (catParsed.sceneLocation) sceneLocation = catParsed.sceneLocation;
      } catch(_) {
        // Fallback to defaults if classification fails
      }

      const gender = genderHint === 'female' ? 'woman' : genderHint === 'male' ? 'man' : 'person';

      // ── V1-V3: Scene-ready — empty product zone for remix ──────────────────
      // Add unique seed to prevent Imagen returning cached results
      const seed = Date.now();

      const scenePrompt1 = `[${seed}] Editorial lifestyle photograph. A ${gender} in the background, softly blurred, in a ${sceneContext}. In the sharp foreground: ${sceneLocation} with ${sceneObjects} arranged naturally. A clearly visible empty space on the surface — enough room for a product bottle or container to be placed. Natural soft lighting, warm atmosphere. No product packaging or bottles. Photorealistic, 1:1 square format.${modelHint}`;

      const scenePrompt2 = `[${seed+1}] Professional flat lay photograph from above. A ${sceneContext} styled with ${sceneObjects} beautifully arranged. In the centre: a deliberately empty space on ${sceneLocation} — negative space where a product could be placed. Soft natural lighting, subtle shadows. No product packaging, no bottles, no containers. Photorealistic, 1:1 square format, editorial quality.`;

      const scenePrompt3 = `[${seed+2}] Atmospheric lifestyle scene in a ${sceneContext}. ${sceneObjects} placed artfully around ${sceneLocation}. A prominent empty surface area in the foreground, well-lit and clearly defined. Shallow depth of field, warm natural tones. No product packaging, no bottles, no text or labels. Photorealistic, 1:1 square format.${modelHint}`;

      // ── V4-V6: Direct use — AI-generated product in scene ─────────────────
      const directPrompt4 = `[${seed+3}] ` + basePrompt + ` Lifestyle ${sceneContext}, natural ambient lighting, product prominently featured in foreground.`;
      const directPrompt5 = `[${seed+4}] ` + basePrompt + ' Clean studio background, soft professional lighting, product as hero. Minimal, elegant, high-end advertising photography.';
      const directPrompt6 = `[${seed+5}] ` + basePrompt + ` Contextual ${sceneContext}, product in natural use setting. Warm natural light, editorial style.`;

      // Return all 6 prompts for Pro, just s1+v1 for free
      const imagePromptsToReturn = isPro
        ? { s1: scenePrompt1, v1: directPrompt4, v2: directPrompt5 }
        : { s1: scenePrompt1, v1: directPrompt4 };

      return res.json({
        primaryTexts: parsed.primaryTexts || [],
        headlines: (parsed.headlines || []).map(h => h.slice(0, 40)),
        descriptions: (parsed.descriptions || []).map(d => d.slice(0, 30)),
        imageUrl: null,
        imageVariations: [],
        imagePrompt: parsed.imagePrompt,
        imagePrompts: imagePromptsToReturn,
        heroProductImage,
        secondaryImage,
        tertiaryImage,
        homepageImage,
        isPro,
      });
    }
  } // end if (parsed.imagePrompt)

  // Return all scored images for rich thumbnail tray
  const allScoredImages = cleanScored.slice(0, 16).filter(img => img !== heroProductImage);

  return res.json({
    primaryTexts: parsed.primaryTexts || [],
    headlines: (parsed.headlines || []).map(h => h.slice(0, 40)),
    descriptions: (parsed.descriptions || []).map(d => d.slice(0, 30)),
    imageUrl,
    imageVariations,
    imagePrompt: parsed.imagePrompt,
    heroProductImage,
    secondaryImage,
    tertiaryImage,
    homepageImage,
    allImages: allScoredImages,
  });
}
