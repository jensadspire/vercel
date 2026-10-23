/**
 * /api/detect-bg — classify a product image's background for video-engine routing.
 *
 * Samples border points (4 corners + 4 edge mid-points) server-side with sharp (no CORS,
 * unlike a browser canvas) and measures their colour SPREAD:
 *   • low spread  → the border is a uniform SOLID colour (white/grey/beige/…) → 'solid'
 *   • high spread → the border is busy / varied → 'environment'
 * Transparent border pixels vote white (a clean cut-out → solid). This mirrors the corner
 * logic already in /api/normalize-image's sampleBackground.
 *
 * Returns { ok, background:'solid'|'environment', maxSpread, bgEngine:'kling'|'runway' }.
 * bgEngine is ONLY the background's vote (solid→kling, environment→runway); the frontend
 * combines it with the existing lifestyle/model heuristic (which can override to runway).
 * Any failure falls back to 'solid' / 'kling' — the safe generic default (today's behaviour).
 *
 * Body: { imageUrl, threshold? }
 */

const DEFAULT_THRESHOLD = 32; // max per-channel border spread still counted as "solid"

export async function classifyBackground(sharp, buf, threshold = DEFAULT_THRESHOLD) {
  const meta = await sharp(buf).metadata();
  const W = meta.width, H = meta.height;
  if (!W || !H) return { background: 'solid', maxSpread: 0, bgEngine: 'kling' };
  const cx = Math.max(0, Math.floor(W / 2) - 1), cy = Math.max(0, Math.floor(H / 2) - 1);
  const pts = [
    [0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1],       // corners
    [cx, 0], [cx, H - 1], [0, cy], [W - 1, cy],            // edge mid-points
  ];
  const rgb = [];
  for (const [left, top] of pts) {
    try {
      const { data, info } = await sharp(buf)
        .extract({ left, top, width: 1, height: 1 })
        .raw().toBuffer({ resolveWithObject: true });
      const alpha = info.channels >= 4 ? data[3] : 255;
      if (alpha < 200) rgb.push([255, 255, 255]);          // transparent → white vote
      else rgb.push([data[0], data[1], data[2]]);
    } catch { rgb.push([255, 255, 255]); }
  }
  const spread = (i) => Math.max(...rgb.map((s) => s[i])) - Math.min(...rgb.map((s) => s[i]));
  const maxSpread = Math.max(spread(0), spread(1), spread(2));
  const background = maxSpread <= threshold ? 'solid' : 'environment';
  return { background, maxSpread, bgEngine: background === 'solid' ? 'kling' : 'runway' };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageUrl } = req.body || {};
  const threshold = Number((req.body && req.body.threshold)) || DEFAULT_THRESHOLD;
  if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required' });

  try {
    const srcRes = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) });
    if (!srcRes.ok) {
      return res.status(200).json({ ok: false, background: 'solid', bgEngine: 'kling', error: 'fetch HTTP ' + srcRes.status });
    }
    const buf = Buffer.from(await srcRes.arrayBuffer());
    const sharp = (await import('sharp')).default;
    const r = await classifyBackground(sharp, buf, threshold);
    return res.status(200).json({ ok: true, ...r });
  } catch (e) {
    // Fail-safe: default to solid / kling (today's generic behaviour).
    return res.status(200).json({ ok: false, background: 'solid', bgEngine: 'kling', error: String((e && e.message) || e) });
  }
}
