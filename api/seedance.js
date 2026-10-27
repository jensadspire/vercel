/**
 * /api/seedance — ByteDance Seedance 2.0 (reference-to-video) via fal.ai REST API.
 *
 * The character-consistency engine: fal's "omni-reference" mode takes up to 9 reference images of a
 * subject (tagged @Image1..@ImageN in the prompt) and holds that identity across a multi-shot clip —
 * which is what makes a Personas-Builder character re-poseable across scenes.
 *
 * Isolated spike endpoint (new file, mirrors the kling.js create→poll contract so a client poll loop
 * works the same): nothing in the existing engines changes.
 *   create (default): { requestId, status, statusUrl, responseUrl }
 *   poll:             { status, videoUrl }   (videoUrl set only when COMPLETED)
 *
 * Deliberately a DUMB forwarder for the spike — it passes the prompt through verbatim so we can iterate
 * on prompt engineering (the consistency template) without redeploying. Prompt construction (shot-list,
 * consistency rules) lives upstream, not here.
 *
 * Notes from the fal schema:
 *   - image_urls is an array of URLs (NOT base64) → the Character Library's Blob URLs feed it directly.
 *   - No negative_prompt field on reference-to-video → "no on-screen text / captions / watermarks" must
 *     be stated positively in the prompt.
 *   - seed is the reproducibility lever for cross-clip identity; generate_audio defaults false (our ad
 *     convention — captions/CTA are burned in post, not drawn by the model).
 *
 * Env: FAL_API_KEY (already configured for kling.js).
 */

import { labelAndStore } from './_ai-label.js';

const SEEDANCE_STD  = 'bytedance/seedance-2.0/reference-to-video';
const SEEDANCE_FAST = 'bytedance/seedance-2.0/fast/reference-to-video';
const SEEDANCE_BASE = 'bytedance/seedance-2.0'; // queue base for status/result polling

export const config = { api: { bodyParser: { sizeLimit: '6mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = process.env.FAL_API_KEY;
  if (!falKey) return res.status(500).json({ error: 'FAL_API_KEY not configured' });

  const {
    imageUrls, prompt,
    duration = '8', resolution = '720p', aspectRatio = '9:16',
    generateAudio = false, seed, fast = false,
    action = 'create', requestId, statusUrl, responseUrl,
  } = req.body || {};

  const authHeaders = { 'Authorization': `Key ${falKey}` };
  const jsonHeaders = { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' };

  const safeJson = async (r) => {
    try { const t = await r.text(); return t && t.trim() ? JSON.parse(t) : {}; }
    catch (_) { return {}; }
  };

  try {
    // ── Poll existing task ──────────────────────────────────────────────────────
    if (action === 'poll' && requestId) {
      const sUrl = statusUrl || `https://queue.fal.run/${SEEDANCE_BASE}/requests/${requestId}/status`;
      const statusRes = await fetch(sUrl, { method: 'GET', headers: authHeaders });
      const statusData = await safeJson(statusRes);
      console.log('[seedance] status HTTP:', statusRes.status, 'status:', statusData.status);

      if (statusData.status === 'COMPLETED') {
        const rUrl = responseUrl || `https://queue.fal.run/${SEEDANCE_BASE}/requests/${requestId}`;
        const resultRes = await fetch(rUrl, { method: 'GET', headers: authHeaders });
        const result = await safeJson(resultRes);
        const rawVideoUrl = result.video?.url || result.video_url || null;
        console.log('[seedance] COMPLETED - rawVideoUrl:', rawVideoUrl, '| seed:', result.seed);

        if (!rawVideoUrl) return res.status(200).json({ status: 'COMPLETED', videoUrl: null, seed: result.seed ?? null });

        // EU AI Act: shared label+store stage (fail-open), same as the other engines.
        const { url: videoUrl, labelled } = await labelAndStore(rawVideoUrl, 'seedance');
        if (!labelled) console.error('[ai-label] Delivering UNLABELLED Seedance video (Rendi unavailable)');
        return res.status(200).json({
          status: 'COMPLETED',
          videoUrl,
          seed: result.seed ?? null,
          labelled,
          ...(labelled ? {} : { labelNote: "Your video is ready. We couldn't add the AI-content label on this one — you can re-run it, or add the label before publishing." }),
        });
      }

      if (statusData.status === 'FAILED') return res.status(200).json({ status: 'FAILED', videoUrl: null });
      return res.status(200).json({ status: statusData.status || 'IN_QUEUE', videoUrl: null });
    }

    // ── Create new task ─────────────────────────────────────────────────────────
    if (!Array.isArray(imageUrls) || !imageUrls.length) {
      return res.status(400).json({ error: 'imageUrls (array of reference image URLs) required' });
    }
    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt required' });
    if (imageUrls.length > 9) return res.status(400).json({ error: 'Seedance accepts at most 9 reference images.' });

    const body = {
      prompt: String(prompt).slice(0, 5000),
      image_urls: imageUrls.slice(0, 9),
      resolution,
      duration: String(duration),
      aspect_ratio: aspectRatio,
      generate_audio: !!generateAudio,
      ...(Number.isInteger(seed) ? { seed } : {}),
    };

    const submitRes = await fetch(`https://queue.fal.run/${fast ? SEEDANCE_FAST : SEEDANCE_STD}`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify(body),
    });
    const submitData = await safeJson(submitRes);
    console.log('[seedance] submit HTTP:', submitRes.status, 'requestId:', submitData.request_id);

    if (!submitRes.ok || !submitData.request_id) {
      return res.status(500).json({
        error: submitData.detail || submitData.message || 'Seedance generation failed to start',
        detail: JSON.stringify(submitData).slice(0, 400),
      });
    }

    return res.status(200).json({
      requestId: submitData.request_id,
      status: submitData.status || 'IN_QUEUE',
      statusUrl: submitData.status_url || null,     // pass back on poll for robust URL resolution
      responseUrl: submitData.response_url || null,
    });

  } catch (err) {
    console.error('[seedance] handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
