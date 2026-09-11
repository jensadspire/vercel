/**
 * /api/brand-outro — append a branded outro card to a generated ad video, via Creatomate.
 *
 * Takes the user's generated ad video + their saved brand, and renders (through a
 * Creatomate template) a merged video: the ad → fade → branded outro card
 * (logo + domain + tagline). Server-side only — the Creatomate key never reaches
 * the browser.
 *
 *   POST /api/brand-outro
 *     body: { adVideoUrl, productUrl? }   (signed-in only)
 *     → create:  starts the render, returns { renderId, status }
 *     → poll:    { action:"poll", renderId } → { status, url }
 *
 * Element mapping (template 80ccde4c-32b6-4246-886f-2cba557ec94e):
 *   Video-5ND               ← adVideoUrl (the generated ad)
 *   Logo                    ← brand.logo
 *   Tagline-/-Payoff-/-CTA  ← brand.ctaText
 *   Domain                  ← domain extracted from productUrl (e.g. "dilling.com")
 *
 * The fade transition + card design live in the Creatomate template, not here —
 * so the outro look can be tuned in their editor with no code change.
 */

const TEMPLATE_ID = '80ccde4c-32b6-4246-886f-2cba557ec94e';

// Decode Clerk session JWT → user id (same as /api/brand). Signed-in only.
function clerkUserId(req) {
  const tok = req.headers['x-clerk-session'] || '';
  if (!tok) return null;
  try {
    const parts = tok.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.sub && payload.exp && payload.exp > now) return payload.sub;
  } catch (_) {}
  return null;
}

// Upstash Redis (same REST pattern as the other endpoints) — to read brand:{userId}.
async function redisGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const res = await fetch(`${url}/GET/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.result || null;
}

// Extract a clean domain from a URL or bare domain string.
function extractDomain(input) {
  if (!input || typeof input !== 'string') return '';
  let d = input.trim().toLowerCase();
  try { if (d.startsWith('http')) d = new URL(d).hostname; } catch (_) {}
  d = d.replace(/^www\./, '').replace(/\/.*$/, '').replace(/:.*$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : '';
}

const CM_BASE = 'https://api.creatomate.com/v2/renders';

async function cmHeaders() {
  return {
    Authorization: `Bearer ${process.env.CREATOMATE_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-clerk-session');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const userId = clerkUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required.' });

  if (!process.env.CREATOMATE_API_KEY) {
    return res.status(500).json({ error: 'Branded outro not configured.' });
  }

  const { action = 'create', adVideoUrl, productUrl, renderId } = req.body || {};

  try {
    // ── Poll ──────────────────────────────────────────────────────────────────
    if (action === 'poll') {
      if (!renderId) return res.status(400).json({ error: 'renderId required for poll' });
      const r = await fetch(`${CM_BASE}/${encodeURIComponent(renderId)}`, { headers: await cmHeaders() });
      if (!r.ok) return res.status(200).json({ status: 'failed', error: `poll http ${r.status}` });
      const data = await r.json();
      // Creatomate statuses: planned | waiting | transcribing | rendering | succeeded | failed
      return res.status(200).json({
        status: data.status,
        url: data.status === 'succeeded' ? (data.url || null) : null,
        ...(data.status === 'failed' ? { error: data.error_message || 'render failed' } : {}),
      });
    }

    // ── Create ────────────────────────────────────────────────────────────────
    if (!adVideoUrl) return res.status(400).json({ error: 'adVideoUrl required' });

    // Read the user's saved brand for logo + CTA.
    let brand = {};
    const raw = await redisGet(`brand:${userId}`);
    if (raw) { try { brand = JSON.parse(raw); } catch {} }

    const domain = extractDomain(productUrl);

    // Primary brand colour (Brandfetch ranks accent/brand first). Falls back to a
    // neutral if none saved, so the shapes always have a valid colour.
    const primaryColor = (Array.isArray(brand.colors) && brand.colors[0]) ? brand.colors[0] : '#111111';

    // Keys use the EXACT fully-qualified property format from Creatomate's API
    // Integration panel for this template (element name + '.' + property).
    const modifications = {
      'Video-5ND.source': adVideoUrl,
      'Logo.source': brand.logo || '',
      'Domain.text': domain,
      'Tagline-/-Payoff-/-CTA.text': brand.ctaText || '',
      // 4 corner triangles → primary brand colour (fill + stroke).
      'Shape-KVF.fill_color': primaryColor,
      'Shape-KVF.stroke_color': primaryColor,
      'Shape-M65.fill_color': primaryColor,
      'Shape-M65.stroke_color': primaryColor,
      'Shape-X3B.fill_color': primaryColor,
      'Shape-X3B.stroke_color': primaryColor,
      'Shape-6MK.fill_color': primaryColor,
      'Shape-6MK.stroke_color': primaryColor,
    };

    const createRes = await fetch(CM_BASE, {
      method: 'POST',
      headers: await cmHeaders(),
      body: JSON.stringify({
        template_id: TEMPLATE_ID,
        modifications,
        output_format: 'mp4',
      }),
    });

    if (!createRes.ok) {
      const detail = await createRes.text().catch(() => '');
      console.error('[brand-outro] create failed:', createRes.status, detail.slice(0, 200));
      return res.status(200).json({ status: 'failed', error: `Outro render could not start (status ${createRes.status}).` });
    }

    // Creatomate returns an array of render objects (one per output).
    const created = await createRes.json();
    const first = Array.isArray(created) ? created[0] : created;
    if (!first || !first.id) {
      return res.status(200).json({ status: 'failed', error: 'No render id returned.' });
    }

    // If it already succeeded synchronously (short renders can), pass the url through.
    return res.status(200).json({
      renderId: first.id,
      status: first.status || 'planned',
      url: first.status === 'succeeded' ? (first.url || null) : null,
    });
  } catch (err) {
    console.error('[brand-outro] error:', err?.message || err);
    return res.status(500).json({ error: String(err?.message || err).slice(0, 300) });
  }
}
