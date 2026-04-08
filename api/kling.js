/**
 * /api/kling — Kling AI video generation via fal.ai REST API
 * Key insight from fal.ai docs: subpath used for submit only,
 * status/result use base model ID without subpath
 */

const KLING_SUBMIT = 'fal-ai/kling-video/v2.1/pro/image-to-video';
const KLING_BASE   = 'fal-ai/kling-video';  // used for status + result polling

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = process.env.FAL_API_KEY;
  if (!falKey) return res.status(500).json({ error: 'FAL_API_KEY not configured' });

  const { imageUrl, storyboard, prompt, action = 'create', requestId } = req.body || {};
  const authHeaders = { 'Authorization': `Key ${falKey}` };
  const jsonHeaders = { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' };

  const safeJson = async (r) => {
    try {
      const text = await r.text();
      if (!text || !text.trim()) return {};
      return JSON.parse(text);
    } catch (_) { return {}; }
  };

  try {
    // ── Poll existing task ──────────────────────────────────────────────────────
    if (action === 'poll' && requestId) {
      const statusUrl = `https://queue.fal.run/${KLING_BASE}/requests/${requestId}/status`;
      const statusRes = await fetch(statusUrl, { method: 'GET', headers: authHeaders });
      const statusData = await safeJson(statusRes);
      console.log('Status HTTP:', statusRes.status, 'status:', statusData.status);

      if (statusData.status === 'COMPLETED') {
        const resultUrl = `https://queue.fal.run/${KLING_BASE}/requests/${requestId}`;
        const resultRes = await fetch(resultUrl, { method: 'GET', headers: authHeaders });
        const result = await safeJson(resultRes);
        console.log('Result:', JSON.stringify(result).slice(0, 200));
        const videoUrl = result.video?.url || result.video_url || null;
        return res.status(200).json({ status: 'COMPLETED', videoUrl });
      }

      if (statusData.status === 'FAILED') {
        return res.status(200).json({ status: 'FAILED', videoUrl: null });
      }

      return res.status(200).json({ status: statusData.status || 'IN_QUEUE', videoUrl: null });
    }

    // ── Create new video task ───────────────────────────────────────────────────
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });

    let videoPrompt = '';
    if (storyboard && storyboard.length > 0) {
      videoPrompt = storyboard
        .map(s => `(${s.timing}) ${s.title}: ${s.description}`)
        .join(' ')
        .slice(0, 2500);
    } else {
      videoPrompt = (prompt || 'Cinematic 9:16 vertical product advertisement, smooth camera movement.').slice(0, 2500);
    }

    let imageData = imageUrl;
    try {
      const imgRes = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' } });
      if (imgRes.ok) {
        const buf = await imgRes.arrayBuffer();
        const b64 = Buffer.from(buf).toString('base64');
        const ct = imgRes.headers.get('content-type') || 'image/jpeg';
        imageData = `data:${ct};base64,${b64}`;
      }
    } catch (_) {}

    const submitRes = await fetch(`https://queue.fal.run/${KLING_SUBMIT}`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        image_url: imageData,
        prompt: videoPrompt,
        duration: '10',
        aspect_ratio: '9:16',
        cfg_scale: 0.5,
      }),
    });

    const submitData = await safeJson(submitRes);
    console.log('Submit HTTP:', submitRes.status, 'requestId:', submitData.request_id);

    if (!submitRes.ok) {
      return res.status(500).json({
        error: submitData.detail || submitData.message || 'Kling generation failed',
        detail: JSON.stringify(submitData),
      });
    }

    return res.status(200).json({
      requestId: submitData.request_id,
      status: submitData.status || 'IN_QUEUE',
    });

  } catch (err) {
    console.error('Kling handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
