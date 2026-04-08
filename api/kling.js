/**
 * /api/kling — Kling AI video generation via fal.ai REST API
 */

const KLING_MODEL = 'fal-ai/kling-video/v2.1/pro/image-to-video';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = process.env.FAL_API_KEY;
  if (!falKey) return res.status(500).json({ error: 'FAL_API_KEY not configured' });

  const { imageUrl, storyboard, prompt, action = 'create', requestId } = req.body || {};

  const headers = {
    'Authorization': `Key ${falKey}`,
    'Content-Type': 'application/json',
  };

  const safeJson = async (r) => {
    try {
      const text = await r.text();
      console.log('Raw response (HTTP', r.status, '):', text.slice(0, 300));
      if (!text || !text.trim()) return {};
      return JSON.parse(text);
    } catch (e) {
      console.log('JSON parse error:', e.message);
      return {};
    }
  };

  try {
    // ── Poll existing task ──────────────────────────────────────────────────────
    if (action === 'poll' && requestId) {

      // Try result endpoint first — returns 200 when done, 202 when still processing
      const resultRes = await fetch(
        `https://queue.fal.run/${KLING_MODEL}/requests/${requestId}`,
        { headers }
      );

      console.log('Result endpoint HTTP status:', resultRes.status);

      if (resultRes.status === 200) {
        const result = await safeJson(resultRes);
        const videoUrl = result.video?.url || result.video_url || null;
        console.log('COMPLETED - videoUrl:', videoUrl, 'full result:', JSON.stringify(result).slice(0, 200));
        return res.status(200).json({ status: 'COMPLETED', videoUrl });
      }

      // Still processing — check status
      const statusRes = await fetch(
        `https://queue.fal.run/${KLING_MODEL}/requests/${requestId}/status`,
        { headers }
      );
      const statusData = await safeJson(statusRes);

      if (statusData.status === 'FAILED') {
        return res.status(200).json({ status: 'FAILED', videoUrl: null });
      }

      return res.status(200).json({
        status: statusData.status || 'IN_QUEUE',
        videoUrl: null,
      });
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

    // Fetch image and convert to base64
    let imageData = imageUrl;
    try {
      const imgRes = await fetch(imageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }
      });
      if (imgRes.ok) {
        const buf = await imgRes.arrayBuffer();
        const b64 = Buffer.from(buf).toString('base64');
        const ct = imgRes.headers.get('content-type') || 'image/jpeg';
        imageData = `data:${ct};base64,${b64}`;
      }
    } catch (_) {}

    const submitRes = await fetch(`https://queue.fal.run/${KLING_MODEL}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        image_url: imageData,
        prompt: videoPrompt,
        duration: '10',
        aspect_ratio: '9:16',
        cfg_scale: 0.5,
      }),
    });

    const submitData = await safeJson(submitRes);

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
