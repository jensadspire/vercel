/**
 * /api/veo — Google VEO (Gemini API) image-to-video generation.
 *
 * Mirrors the create→poll contract of /api/kling and /api/runway so the existing
 * frontend polling loop works unchanged:
 *   create (default): { requestId, status }   — requestId = Google operation name
 *   poll:             { status, videoUrl }     — videoUrl set only when finished
 *
 * VEO uses a long-running-operation pattern:
 *   1. POST :predictLongRunning  → returns an operation { name }
 *   2. GET  the operation name    → poll until done:true
 *   3. extract the video URI/bytes from the operation response
 *
 * FAIL-OPEN AI label via _ai-label.js, identical to the other engines.
 *
 * NOTE: model id, endpoint paths and response shape are per Google's current GenAI
 * video API and may need a one-time test-and-fix to match the live API exactly.
 */

import { labelAndStore } from './_ai-label.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Model id — verify against current Google docs (veo-3.1 / veo-3.0 / veo-3.1-fast etc.)
const VEO_MODEL = process.env.VEO_MODEL || 'veo-3.1-generate-preview';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const { imageUrl, prompt, action = 'create', requestId } = req.body || {};

  const safeJson = async (r) => {
    try { const t = await r.text(); return t && t.trim() ? JSON.parse(t) : {}; }
    catch (_) { return {}; }
  };

  try {
    // ── Poll existing operation ─────────────────────────────────────────────────
    if (action === 'poll' && requestId) {
      // requestId is the full operation name, e.g. "models/veo-3.1.../operations/abc123"
      const opRes = await fetch(`${GEMINI_BASE}/${requestId}?key=${key}`, { method: 'GET' });
      const op = await safeJson(opRes);

      if (!op.done) {
        return res.status(200).json({ status: 'IN_PROGRESS', videoUrl: null });
      }
      if (op.error) {
        console.error('[veo] operation error:', JSON.stringify(op.error).slice(0, 300));
        return res.status(200).json({ status: 'FAILED', videoUrl: null });
      }

      // Extract the generated video. Shape per current API:
      // op.response.generateVideoResponse.generatedSamples[0].video.uri  (a signed file URI)
      const resp = op.response || {};
      const gv = resp.generateVideoResponse || resp;
      const sample = gv?.generatedSamples?.[0] || gv?.generatedVideos?.[0] || null;
      let rawVideoUrl = sample?.video?.uri || sample?.video?.url || sample?.uri || null;

      if (!rawVideoUrl) {
        console.error('[veo] done but no video uri:', JSON.stringify(op).slice(0, 400));
        return res.status(200).json({ status: 'COMPLETED', videoUrl: null });
      }

      // The VEO file URI often needs the API key appended to download it.
      const downloadUrl = rawVideoUrl.includes('key=') ? rawVideoUrl
        : rawVideoUrl + (rawVideoUrl.includes('?') ? '&' : '?') + 'key=' + key;

      // ── EU AI Act: label via Rendi + store to Blob (shared stage, fail-open) ──
      const { url: videoUrl, labelled } = await labelAndStore(downloadUrl, 'veo');
      if (!labelled) console.error('[ai-label] Delivering UNLABELLED VEO video (Rendi unavailable)');
      return res.status(200).json({
        status: 'COMPLETED',
        videoUrl,
        labelled,
        ...(labelled ? {} : { labelNote: "Your video is ready. We couldn't add the AI-content label on this one — you can re-run it, or add the label before publishing." }),
      });
    }

    // ── Create new video operation ──────────────────────────────────────────────
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });

    const motionPrompt = (prompt || 'Cinematic product advertisement, smooth camera movement, aspirational lighting.').slice(0, 2000);

    // Fetch the product image → base64 (VEO image-to-video takes inline image bytes).
    let imageB64 = null, imageMime = 'image/jpeg';
    try {
      const imgRes = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }, signal: AbortSignal.timeout(10000) });
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        let ct = (imgRes.headers.get('content-type') || 'image/jpeg').split(';')[0];
        // flatten alpha → white (same reasoning as kling.js)
        try {
          const sharp = (await import('sharp')).default;
          const meta = await sharp(buf).metadata();
          if (meta.hasAlpha) {
            const flat = await sharp(buf).flatten({ background: '#ffffff' }).jpeg().toBuffer();
            imageB64 = flat.toString('base64'); imageMime = 'image/jpeg';
          } else {
            imageB64 = buf.toString('base64'); imageMime = ct || 'image/jpeg';
          }
        } catch (_) {
          imageB64 = buf.toString('base64'); imageMime = ct || 'image/jpeg';
        }
      }
    } catch (e) {
      console.error('[veo] image fetch failed:', e.message);
    }
    if (!imageB64) return res.status(400).json({ error: 'Could not fetch product image for VEO' });

    // Submit the long-running generate request.
    const submitRes = await fetch(`${GEMINI_BASE}/models/${VEO_MODEL}:predictLongRunning?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{
          prompt: motionPrompt,
          image: { bytesBase64Encoded: imageB64, mimeType: imageMime },
        }],
        parameters: {
          aspectRatio: '9:16',
          // VEO native prompt enhancement — expands our brief into VEO's cinematic dialect.
          // Toggle via env VEO_ENHANCE ('off' to disable for A/B). If this exact key is
          // wrong for the direct Gemini endpoint, adjust the name/location here.
          enhancePrompt: (process.env.VEO_ENHANCE || 'on') !== 'off',
          // durationSeconds / personGeneration / sampleCount etc. — add per current API as needed
        },
      }),
    });
    const submitData = await safeJson(submitRes);
    console.log('[veo] submit HTTP:', submitRes.status, 'op:', submitData.name || JSON.stringify(submitData).slice(0, 200));

    if (!submitRes.ok || !submitData.name) {
      return res.status(500).json({
        error: submitData.error?.message || 'VEO generation failed to start',
        detail: JSON.stringify(submitData).slice(0, 400),
      });
    }

    // Return the operation name as requestId so the existing poll loop can track it.
    return res.status(200).json({ requestId: submitData.name, status: 'IN_QUEUE' });

  } catch (err) {
    console.error('[veo] handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
