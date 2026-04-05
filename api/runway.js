/**
 * /api/runway — Runway ML Gen-3 Alpha image-to-video
 * Input:  { imageUrl, prompt, duration? }
 * Output: { videoUrl, taskId } or { status, videoUrl } for polling
 *
 * Flow:
 *   1. POST to Runway to create a task → returns taskId
 *   2. Poll GET until status = SUCCEEDED → returns videoUrl
 */

const RUNWAY_API = 'https://api.dev.runwayml.com/v1';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const runwayKey = process.env.RUNWAY_API_KEY;
  if (!runwayKey) return res.status(500).json({ error: 'Runway API key not configured' });

  const { imageUrl, prompt, duration = 5, action = 'create', taskId } = req.body || {};

  try {
    // ── Poll existing task ────────────────────────────────────────────────────
    if (action === 'poll' && taskId) {
      const r = await fetch(`${RUNWAY_API}/tasks/${taskId}`, {
        headers: {
          'Authorization': `Bearer ${runwayKey}`,
          'X-Runway-Version': '2024-11-06',
        },
      });
      const data = await r.json();
      return res.status(200).json({
        status: data.status,
        videoUrl: data.output?.[0] || null,
        progress: data.progress || 0,
      });
    }

    // ── Create new video task ─────────────────────────────────────────────────
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });

    const motionPrompt = (prompt || 'Smooth cinematic camera movement, professional product advertisement style').slice(0, 1000);

    // ── Fetch image and convert to base64 — Runway needs accessible image ──
    let promptImage = imageUrl;
    try {
      const imgRes = await fetch(imageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }
      });
      if (imgRes.ok) {
        const imgBuffer = await imgRes.arrayBuffer();
        const imgBase64 = Buffer.from(imgBuffer).toString('base64');
        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        promptImage = `data:${contentType};base64,${imgBase64}`;
      }
    } catch (_) {}

    const r = await fetch(`${RUNWAY_API}/image_to_video`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${runwayKey}`,
        'X-Runway-Version': '2024-11-06',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gen3a_turbo',
        promptImage: promptImage,
        promptText: motionPrompt,
        duration,
        ratio: '768:1280',
        watermark: false,
      }),
    });

    const data = await r.json();

    if (!r.ok) {
      console.error('Runway error:', JSON.stringify(data));
      return res.status(500).json({ error: data.message || 'Runway generation failed', detail: JSON.stringify(data) });
    }

    return res.status(200).json({
      taskId: data.id,
      status: data.status,
    });

  } catch (err) {
    console.error('Runway handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
