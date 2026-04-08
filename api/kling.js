/**
 * /api/kling — Kling AI video generation via fal.ai
 * Input:  { imageUrl, storyboard, prompt, action?, taskId? }
 * Output: { videoUrl, taskId } or { status, videoUrl } for polling
 *
 * Flow:
 *   1. POST to fal.ai with image + multi-scene storyboard prompt → returns requestId
 *   2. Poll GET until status = COMPLETED → returns videoUrl
 *
 * Storyboard scenes are mapped to a structured temporal prompt:
 *   (0s-3s) Scene 1... (3s-8s) Scene 2... etc.
 */

const FAL_API = 'https://queue.fal.run';
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

  try {
    // ── Poll existing task ──────────────────────────────────────────────────────
    if (action === 'poll' && requestId) {
      const r = await fetch(`${FAL_API}/${KLING_MODEL}/requests/${requestId}/status`, {
        headers: { 'Authorization': `Key ${falKey}` },
      });
      const data = await r.json();

      if (data.status === 'COMPLETED') {
        // Fetch the actual result
        const resultRes = await fetch(`${FAL_API}/${KLING_MODEL}/requests/${requestId}`, {
          headers: { 'Authorization': `Key ${falKey}` },
        });
        const result = await resultRes.json();
        return res.status(200).json({
          status: 'COMPLETED',
          videoUrl: result.video?.url || result.video_url || null,
        });
      }

      return res.status(200).json({
        status: data.status || 'IN_PROGRESS',
        videoUrl: null,
      });
    }

    // ── Create new video task ───────────────────────────────────────────────────
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });

    // ── Build multi-scene prompt from storyboard ────────────────────────────────
    let videoPrompt = '';
    if (storyboard && storyboard.length > 0) {
      // Map each scene to temporal format: (0s-3s) description...
      const sceneParts = storyboard.map(scene => {
        return `(${scene.timing}) ${scene.title}: ${scene.description}`;
      });
      videoPrompt = sceneParts.join(' ');
      // Cap at 2500 chars (Kling limit)
      videoPrompt = videoPrompt.slice(0, 2500);
    } else if (prompt) {
      videoPrompt = prompt.slice(0, 2500);
    } else {
      videoPrompt = 'Cinematic 9:16 vertical product advertisement. Smooth camera movement, professional lighting, engaging motion.';
    }

    // ── Fetch image and convert to base64 ──────────────────────────────────────
    let imageData = imageUrl;
    try {
      const imgRes = await fetch(imageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }
      });
      if (imgRes.ok) {
        const imgBuffer = await imgRes.arrayBuffer();
        const imgBase64 = Buffer.from(imgBuffer).toString('base64');
        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        imageData = `data:${contentType};base64,${imgBase64}`;
      }
    } catch (_) {}

    // ── Submit to fal.ai queue ──────────────────────────────────────────────────
    const r = await fetch(`${FAL_API}/${KLING_MODEL}`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${falKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image_url: imageData,
        prompt: videoPrompt,
        duration: '10',
        aspect_ratio: '9:16',
        cfg_scale: 0.5,
      }),
    });

    const data = await r.json();

    if (!r.ok) {
      console.error('Kling/fal error:', JSON.stringify(data));
      return res.status(500).json({ error: data.message || data.detail || 'Kling generation failed', detail: JSON.stringify(data) });
    }

    return res.status(200).json({
      requestId: data.request_id,
      status: data.status || 'IN_QUEUE',
    });

  } catch (err) {
    console.error('Kling handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
