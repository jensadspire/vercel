/**
 * /api/persona-image — synthetic persona image generator (Personas character builder, Phase 1).
 *
 * Three image engines behind ONE interface for a bake-off, so we can compare photorealism and pick the
 * best face source. Text-to-image only (a synthetic, non-real person) → stored to Vercel Blob → returns a
 * stable { imageUrl } that drops straight into /api/seedance. Synthetic faces clear Seedance's
 * real-likeness moderation wall (the content_policy_violation we hit with real model photos).
 *
 *   model: 'flux'     → fal  fal-ai/flux-pro/v1.1                      (FAL_API_KEY)  — top photoreal
 *   model: 'seedream' → fal  fal-ai/bytedance/seedream/v4/text-to-image(FAL_API_KEY) — same family as Seedance
 *   model: 'imagen'   → proxies the existing /api/imagen              (reused, not duplicated)
 *
 * Isolated new file — touches nothing existing. Fal image calls use the synchronous fal.run endpoint
 * (images return in seconds, no polling).
 *
 * Env: FAL_API_KEY; PUBLIC_BASE_URL (to reach /api/imagen); BLOB_READ_WRITE_TOKEN.
 */

const BASE = process.env.PUBLIC_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
const FLUX_SLUG = 'fal-ai/flux-pro/v1.1';
const SEEDREAM_SLUG = 'fal-ai/bytedance/seedream/v4/text-to-image';

export const config = { api: { bodyParser: { sizeLimit: '6mb' } } };

// Flux takes a size enum; Seedream takes explicit width/height (960–4096). Imagen takes the ratio string.
const fluxSize = (ar) => ({ '1:1': 'square_hd', '9:16': 'portrait_16_9', '3:4': 'portrait_4_3', '16:9': 'landscape_16_9', '4:3': 'landscape_4_3' }[ar] || 'portrait_4_3');
const seedreamSize = (ar) => ({ '1:1': { width: 2048, height: 2048 }, '9:16': { width: 1152, height: 2048 }, '3:4': { width: 1536, height: 2048 }, '16:9': { width: 2048, height: 1152 }, '4:3': { width: 2048, height: 1536 } }[ar] || { width: 1536, height: 2048 });

// Re-host a model's output image on our own Blob so the URL is stable (fal URLs can expire).
async function toBlob(imageUrl, tag) {
  const r = await fetch(imageUrl);
  if (!r.ok) throw new Error('image download failed ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = (r.headers.get('content-type') || 'image/png').split(';')[0];
  const ext = ct.includes('png') ? 'png' : 'jpg';
  const { put } = await import('@vercel/blob');
  const blob = await put(`persona-${tag}-${Date.now()}.${ext}`, buf, { access: 'public', contentType: ct, token: process.env.BLOB_READ_WRITE_TOKEN });
  return blob.url;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { model = 'flux', prompt, aspectRatio = '3:4', seed } = req.body || {};
  if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt required' });

  try {
    // ── Imagen: reuse the existing /api/imagen (text-to-image → Blob) ──
    if (model === 'imagen') {
      if (!BASE) return res.status(500).json({ error: 'PUBLIC_BASE_URL not set (needed to reach /api/imagen)' });
      const r = await fetch(`${BASE}/api/imagen`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, aspectRatio }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.imageUrl) return res.status(500).json({ error: (d && d.error) || 'Imagen failed', model: 'imagen' });
      return res.status(200).json({ imageUrl: d.imageUrl, model: 'imagen' });
    }

    // ── Flux / Seedream: fal synchronous endpoint ──
    const falKey = process.env.FAL_API_KEY;
    if (!falKey) return res.status(500).json({ error: 'FAL_API_KEY not configured' });
    const headers = { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' };

    let slug, body;
    if (model === 'flux') {
      slug = FLUX_SLUG;
      body = { prompt: String(prompt).slice(0, 5000), image_size: fluxSize(aspectRatio), num_images: 1, output_format: 'png', ...(Number.isInteger(seed) ? { seed } : {}) };
    } else if (model === 'seedream') {
      slug = SEEDREAM_SLUG;
      body = { prompt: String(prompt).slice(0, 5000), image_size: seedreamSize(aspectRatio), num_images: 1, ...(Number.isInteger(seed) ? { seed } : {}) };
    } else {
      return res.status(400).json({ error: `Unknown model: ${model} (use flux | seedream | imagen)` });
    }

    const r = await fetch(`https://fal.run/${slug}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    const falUrl = d && d.images && d.images[0] && d.images[0].url;
    if (!r.ok || !falUrl) {
      return res.status(500).json({ error: (d && (d.detail || d.message)) || 'Image generation failed', model, detail: JSON.stringify(d).slice(0, 500) });
    }
    const imageUrl = await toBlob(falUrl, model);
    return res.status(200).json({ imageUrl, model, seed: d.seed ?? null });

  } catch (err) {
    console.error('[persona-image] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
