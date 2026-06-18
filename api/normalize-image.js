/**
 * /api/normalize-image — crop any source image to an exact Google Ads PMax ratio.
 *
 * Accepts: { imageUrl, slot }
 *   slot 'landscape' → 1200x628  (1.91:1)
 *   slot 'square'    → 1200x1200 (1:1)
 *   slot 'portrait'  → 960x1200  (4:5)
 * Returns: { url, slot, width, height, ratio }  — permanent Vercel Blob URL.
 *
 * Why server-side: Google AssetService rejects off-ratio marketing images
 * (ASPECT_RATIO_NOT_ALLOWED). Imagen yields only near-ratios (16:9, 3:4) and
 * scraped images are arbitrary, so every image must pass through an exact-ratio
 * crop. Doing it on the server (fetch + sharp) avoids the cross-origin canvas
 * taint that blocks normalizing arbitrary scraped CDN URLs in the browser.
 */

const SLOTS = {
  landscape: { w: 1200, h: 628 },   // 1.91:1
  square:    { w: 1200, h: 1200 },  // 1:1
  portrait:  { w: 960,  h: 1200 },  // 4:5
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageUrl, slot } = req.body || {};
  if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required' });
  const target = SLOTS[slot];
  if (!target) {
    return res.status(400).json({ error: `slot must be one of: ${Object.keys(SLOTS).join(', ')}` });
  }

  try {
    // Fetch source bytes server-side (no CORS constraint, unlike a browser canvas).
    const srcRes = await fetch(imageUrl);
    if (!srcRes.ok) {
      return res.status(422).json({ error: `Could not fetch source image (HTTP ${srcRes.status})` });
    }
    const srcBuf = Buffer.from(await srcRes.arrayBuffer());

    // Cover-crop to exact target dims (centered — keeps key content in frame,
    // per Google's center-80% guidance), flatten any transparency to white,
    // encode JPEG (small, well under the 5 MB asset cap).
    const sharp = (await import('sharp')).default;
    const outBuf = await sharp(srcBuf)
      .resize(target.w, target.h, { fit: 'cover', position: 'center' })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 88 })
      .toBuffer();

    const { put } = await import('@vercel/blob');
    const blob = await put(`pmax-${slot}-${Date.now()}.jpg`, outBuf, {
      access: 'public',
      contentType: 'image/jpeg',
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    return res.status(200).json({
      url: blob.url,
      slot,
      width: target.w,
      height: target.h,
      ratio: +(target.w / target.h).toFixed(3),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Normalization failed', detail: String(err?.message || err) });
  }
}
