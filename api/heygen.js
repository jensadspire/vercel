/**
 * /api/heygen — HeyGen Avatar IV via fal.ai
 * Submit: fal-ai/heygen/avatar4/image-to-video (full path)
 * Poll:   fal-ai/heygen (base path — confirmed from status_url in submit response)
 */

const HEYGEN_SUBMIT = 'fal-ai/heygen/avatar4/image-to-video';
const HEYGEN_BASE   = 'fal-ai/heygen';  // base path for status + result

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = process.env.FAL_API_KEY;
  if (!falKey) return res.status(500).json({ error: 'FAL_API_KEY not configured' });

  const { imageUrl, script, voiceId = 'Ivy', action = 'create', requestId } = req.body || {};
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
    // ── Poll ───────────────────────────────────────────────────────────────────
    if (action === 'poll' && requestId) {
      const statusRes = await fetch(
        `https://queue.fal.run/${HEYGEN_BASE}/requests/${requestId}/status`,
        { method: 'GET', headers: authHeaders }
      );
      const statusData = await safeJson(statusRes);
      console.log('HeyGen status:', statusData.status, 'HTTP:', statusRes.status);

      if (statusData.status === 'COMPLETED') {
        const resultRes = await fetch(
          `https://queue.fal.run/${HEYGEN_BASE}/requests/${requestId}`,
          { method: 'GET', headers: authHeaders }
        );
        const result = await safeJson(resultRes);
        console.log('HeyGen result:', JSON.stringify(result).slice(0, 200));
        const videoUrl = result.video?.url || result.video_url || result.url || null;
        return res.status(200).json({ status: 'COMPLETED', videoUrl });
      }

      if (statusData.status === 'FAILED') {
        return res.status(200).json({ status: 'FAILED', videoUrl: null });
      }

      return res.status(200).json({ status: statusData.status || 'IN_QUEUE', videoUrl: null });
    }

    // ── Create ─────────────────────────────────────────────────────────────────
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });
    if (!script) return res.status(400).json({ error: 'script required' });

    const submitRes = await fetch(`https://queue.fal.run/${HEYGEN_SUBMIT}`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        image_url: imageUrl,
        text: script.slice(0, 500),
        voice_id: voiceId,
        resolution: '720p',
        aspect_ratio: '9:16',
        talking_style: 'expressive',
      }),
    });

    const submitData = await safeJson(submitRes);
    console.log('HeyGen submit HTTP:', submitRes.status, 'requestId:', submitData.request_id);

    if (!submitRes.ok) {
      return res.status(500).json({
        error: submitData.detail || submitData.message || 'HeyGen failed',
        detail: JSON.stringify(submitData),
      });
    }

    return res.status(200).json({
      requestId: submitData.request_id,
      status: submitData.status || 'IN_QUEUE',
    });

  } catch (err) {
    console.error('HeyGen error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
