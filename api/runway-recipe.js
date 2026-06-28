/**
 * /api/runway-recipe — Runway Recipes (Product Ad + Product UGC) via @runwayml/sdk
 *
 * Mirrors the create→poll contract of /api/runway so the existing frontend
 * polling loop works unchanged:
 *   create (default): { taskId, status }
 *   poll:             { status, videoUrl, progress }
 *
 * On SUCCEEDED, the recipe output (a temporary Runway URL that EXPIRES) is
 * downloaded and re-uploaded to Vercel Blob (same pattern as /api/imagen),
 * and the permanent Blob URL is returned as videoUrl.
 *
 * Uses the SDK (Runway's recommended path) for the recipe create call —
 * the exact call validated in the playground test. Auth uses the same
 * RUNWAY_API_KEY the rest of the app already authenticates with.
 *
 * Body (create):
 *   mode:          'ad' | 'ugc'              (default 'ad')
 *   imageUrl:      product image URL          (required)
 *   characterImage: creator image URL         (required for ugc)
 *   productImages: optional array of extra product image URLs (ad only)
 *   productInfo:   optional string (<=2500 chars)
 *   userConcept:   optional string (<=3500 chars)
 *   duration:      optional number
 * Body (poll):
 *   action: 'poll', taskId
 */

import RunwayML from '@runwayml/sdk';

const RECIPE_VERSION = '2026-06';
const RATIO = '720:1280'; // 9:16 TikTok-native

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const runwayKey = process.env.RUNWAY_API_KEY;
  if (!runwayKey) return res.status(500).json({ error: 'Runway API key not configured' });

  const client = new RunwayML({ apiKey: runwayKey });

  const {
    action = 'create',
    taskId,
    mode = 'ad',
    imageUrl,
    characterImage,
    productImages,
    productInfo,
    userConcept,
    duration,
  } = req.body || {};

  try {
    // ── Poll ─────────────────────────────────────────────────────────────────
    if (action === 'poll' && taskId) {
      const task = await client.tasks.retrieve(taskId);

      if (task.status !== 'SUCCEEDED') {
        // PENDING | THROTTLED | RUNNING | FAILED | CANCELLED
        return res.status(200).json({
          status: task.status,
          videoUrl: null,
          progress: task.progress || 0,
        });
      }

      // SUCCEEDED — Runway output URL is temporary; persist to Blob.
      const outputUrl = Array.isArray(task.output) ? task.output[0] : (task.output?.url || task.output);
      if (!outputUrl) {
        return res.status(200).json({ status: 'FAILED', videoUrl: null, error: 'No output URL on succeeded task' });
      }

      let blobUrl = outputUrl;
      try {
        const vidRes = await fetch(outputUrl);
        if (!vidRes.ok) throw new Error(`download ${vidRes.status}`);
        const buf = Buffer.from(await vidRes.arrayBuffer());
        const { put } = await import('@vercel/blob');
        const blob = await put(`recipe-${mode}-${Date.now()}.mp4`, buf, {
          access: 'public',
          contentType: 'video/mp4',
          token: process.env.BLOB_READ_WRITE_TOKEN,
        });
        blobUrl = blob.url;
      } catch (storeErr) {
        // If Blob persistence fails, fall back to the (temporary) Runway URL so
        // the user still gets their video this session rather than nothing.
        console.error('Recipe Blob store failed, returning temp URL:', storeErr.message);
      }

      return res.status(200).json({ status: 'SUCCEEDED', videoUrl: blobUrl, progress: 1 });
    }

    // ── Create ────────────────────────────────────────────────────────────────
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl (product image) required' });

    let task;
    if (mode === 'ugc') {
      if (!characterImage) return res.status(400).json({ error: 'characterImage required for UGC mode' });
      task = await client.recipes.productUgc({
        version: RECIPE_VERSION,
        characterImage: { uri: characterImage },
        productImage: { uri: imageUrl },
        ...(productInfo ? { productInfo: String(productInfo).slice(0, 2500) } : {}),
        ...(userConcept ? { userConcept: String(userConcept).slice(0, 3500) } : {}),
        ...(duration ? { duration } : {}),
        ratio: RATIO,
      });
    } else {
      // Ad mode — productImages array (1–10); fall back to the single imageUrl.
      const imgs = (Array.isArray(productImages) && productImages.length ? productImages : [imageUrl])
        .slice(0, 10)
        .map(uri => ({ uri }));
      task = await client.recipes.productAd({
        version: RECIPE_VERSION,
        productImages: imgs,
        ...(productInfo ? { productInfo: String(productInfo).slice(0, 2500) } : {}),
        ...(userConcept ? { userConcept: String(userConcept).slice(0, 3500) } : {}),
        ...(duration ? { duration } : {}),
        ratio: RATIO,
      });
    }

    return res.status(200).json({ taskId: task.id, status: task.status || 'PENDING' });

  } catch (err) {
    // SDK errors often carry useful status/detail
    const detail = err?.error?.error || err?.message || 'Runway recipe failed';
    console.error('runway-recipe error:', detail);
    return res.status(500).json({ error: String(detail).slice(0, 300) });
  }
}
