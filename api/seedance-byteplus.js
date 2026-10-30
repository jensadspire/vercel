/**
 * /api/seedance-byteplus — Dreamina-Seedance video via BytePlus ModelArk (Volcengine Ark API).
 *
 * The trustworthy provider for Seedance omni-reference (character consistency). First attempt is the
 * DIRECT reference-image-URL path (2.5's multimodal reference may take a URL straight); if BytePlus
 * moderation blocks a synthetic face on the direct path, we add the avatar-library ingest step next.
 *
 * Host:  https://ark.ap-southeast.bytepluses.com/api/v3   (confirmed from the console sample)
 * Auth:  Authorization: Bearer <BYTEPLUS_API_DREAMINA_SEEDANCE_25_KEY>  (one Ark key, all models)
 * create: POST /contents/generations/tasks        poll: GET /contents/generations/tasks/{id}
 *
 * Actions (body.action):
 *   create { imageUrls[], prompt, model?, ratio?, duration?, resolution?, mode? } -> { taskId }
 *   poll   { taskId }                                                             -> { status, videoUrl? }
 *
 * mode: 'reference' (default) tags images as reference_image (omni-ref identity anchors);
 *       'image' uses the image as the first frame (image-to-video).
 *
 * Spike posture: surfaces raw Ark payloads on failure so we can correct any field shape fast.
 * Isolated new file.
 */
import { labelAndStore } from './_ai-label.js';

const ARK = 'https://ark.ap-southeast.bytepluses.com/api/v3';
const DEFAULT_MODEL = 'dreamina-seedance-2-5-260628'; // 2.5 (multimodal reference). Cheaper iteration: pass model:'dreamina-seedance-2-0-fast-260128'

export const config = { api: { bodyParser: { sizeLimit: '6mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.BYTEPLUS_API_DREAMINA_SEEDANCE_25_KEY;
  if (!key) return res.status(500).json({ error: 'BYTEPLUS_API_DREAMINA_SEEDANCE_25_KEY not configured' });

  const {
    action = 'create',
    imageUrls, prompt, model, ratio = '9:16', duration = 5, resolution, generateAudio = false, mode = 'reference',
    taskId,
  } = req.body || {};

  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const safeJson = async (r) => { try { const t = await r.text(); return t && t.trim() ? JSON.parse(t) : {}; } catch (_) { return {}; } };

  try {
    // ── POLL ──
    if (action === 'poll') {
      if (!taskId) return res.status(400).json({ error: 'taskId required' });
      const r = await fetch(`${ARK}/contents/generations/tasks/${encodeURIComponent(taskId)}`, { headers });
      const d = await safeJson(r);
      const status = d?.status || d?.data?.status || 'unknown';
      const rawVideoUrl = d?.content?.video_url || d?.data?.content?.video_url || d?.video_url || null;
      if (status === 'succeeded' || rawVideoUrl) {
        if (!rawVideoUrl) return res.status(200).json({ status: 'succeeded', videoUrl: null, raw: JSON.stringify(d).slice(0, 800) });
        const { url: videoUrl, labelled } = await labelAndStore(rawVideoUrl, 'seedance');
        if (!labelled) console.error('[ai-label] Delivering UNLABELLED Seedance(byteplus) video (Rendi unavailable)');
        return res.status(200).json({ status: 'succeeded', videoUrl, labelled });
      }
      if (status === 'failed') return res.status(200).json({ status: 'failed', videoUrl: null, raw: JSON.stringify(d).slice(0, 800) });
      return res.status(200).json({ status });
    }

    // ── CREATE ──
    if (!Array.isArray(imageUrls) || !imageUrls.length) return res.status(400).json({ error: 'imageUrls (array of reference image URLs) required' });
    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt required' });

    const content = [{ type: 'text', text: String(prompt).slice(0, 5000) }];
    for (const u of imageUrls.slice(0, 9)) {
      content.push(mode === 'image'
        ? { type: 'image_url', image_url: { url: u } }                          // first-frame image-to-video
        : { type: 'image_url', image_url: { url: u }, role: 'reference_image' }); // omni-reference identity anchor
    }

    const body = { model: model || DEFAULT_MODEL, content, generate_audio: !!generateAudio, ratio, duration, watermark: false, ...(resolution ? { resolution } : {}) };
    const r = await fetch(`${ARK}/contents/generations/tasks`, { method: 'POST', headers, body: JSON.stringify(body) });
    const d = await safeJson(r);
    const tid = d?.id || d?.task_id || d?.data?.id || null;
    if (!r.ok || !tid) return res.status(500).json({ error: 'byteplus task create failed', detail: JSON.stringify(d).slice(0, 800) });
    return res.status(200).json({ taskId: tid });

  } catch (err) {
    console.error('[seedance-byteplus] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
