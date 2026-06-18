/**
 * /api/normalize-image — crop or fit any source image to an exact Google Ads PMax ratio.
 *
 * Accepts: { imageUrl, slot, fit? }
 *   slot 'landscape' → 1200x628  (1.91:1)
 *   slot 'square'    → 1200x1200 (1:1)
 *   slot 'portrait'  → 960x1200  (4:5)
 *   fit  'cover'   (default) → fill the frame, center-crop the overflow. Best for
 *                              generated/scene images already near the target ratio.
 *   fit  'contain'          → fit the whole image inside the frame, pad the edges.
 *                              Best for product shots on a flat background, where a
 *                              cover-crop would slice off the product. The pad colour
 *                              is auto-sampled from the source corners (seamless on
 *                              white/uniform backgrounds; falls back to white).
 * Returns: { url, slot, fit, width, height, ratio, padColor? } — permanent Blob URL.
 *
 * Why server-side: Google AssetService rejects off-ratio marketing images
 * (ASPECT_RATIO_NOT_ALLOWED). Doing the fetch + sharp work on the server avoids the
 * cross-origin canvas taint that blocks normalizing arbitrary scraped CDN URLs in the browser.
 */

const SLOTS = {
  landscape: { w: 1200, h: 628 },   // 1.91:1
  square:    { w: 1200, h: 1200 },  // 1:1
  portrait:  { w: 960,  h: 1200 },  // 4:5
};

// Sample the four corners to guess a uniform background colour. Transparent corners
// vote white; if the corners disagree (non-uniform bg) we fall back to white, which
// is the safe default for ad creative.
async function sampleBackground(sharp, buf) {
  let meta;
  try { meta = await sharp(buf).metadata(); } catch { return { r: 255, g: 255, b: 255 }; }
  const W = meta.width, H = meta.height;
  if (!W || !H) return { r: 255, g: 255, b: 255 };
  const corners = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]];
  const rgb = [];
  for (const [left, top] of corners) {
    try {
      const { data, info } = await sharp(buf)
        .extract({ left, top, width: 1, height: 1 })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const alpha = info.channels >= 4 ? data[3] : 255;
      if (alpha < 200) rgb.push([255, 255, 255]);          // transparent corner → white
      else rgb.push([data[0], data[1], data[2]]);
    } catch { rgb.push([255, 255, 255]); }
  }
  const spread = (i) => Math.max(...rgb.map((s) => s[i])) - Math.min(...rgb.map((s) => s[i]));
  if (Math.max(spread(0), spread(1), spread(2)) > 24) return { r: 255, g: 255, b: 255 }; // non-uniform → white
  const avg = (i) => Math.round(rgb.reduce((a, s) => a + s[i], 0) / rgb.length);
  return { r: avg(0), g: avg(1), b: avg(2) };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageUrl, slot } = req.body || {};
  const fit = (req.body && req.body.fit) === 'contain' ? 'contain' : 'cover';
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

    const sharp = (await import('sharp')).default;

    let pipeline = sharp(srcBuf);
    let padColor;
    if (fit === 'contain') {
      // Fit the whole image inside the frame and pad to exact dims with the sampled
      // background, so nothing is cropped off the product.
      const bg = await sampleBackground(sharp, srcBuf);
      padColor = `rgb(${bg.r},${bg.g},${bg.b})`;
      pipeline = pipeline
        .resize(target.w, target.h, { fit: 'contain', position: 'center', background: bg })
        .flatten({ background: bg });
    } else {
      // Fill the frame, centre-crop the overflow; flatten any transparency to white.
      pipeline = pipeline
        .resize(target.w, target.h, { fit: 'cover', position: 'center' })
        .flatten({ background: '#ffffff' });
    }
    const outBuf = await pipeline.jpeg({ quality: 88 }).toBuffer();

    const { put } = await import('@vercel/blob');
    const blob = await put(`pmax-${slot}-${fit}-${Date.now()}.jpg`, outBuf, {
      access: 'public',
      contentType: 'image/jpeg',
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    return res.status(200).json({
      url: blob.url,
      slot,
      fit,
      width: target.w,
      height: target.h,
      ratio: +(target.w / target.h).toFixed(3),
      ...(padColor ? { padColor } : {}),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Normalization failed', detail: String(err?.message || err) });
  }
}
