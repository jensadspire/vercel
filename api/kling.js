/**
 * /api/kling — Kling AI video generation via fal.ai REST API
 * Key insight from fal.ai docs: subpath used for submit only,
 * status/result use base model ID without subpath
 */

const KLING_SUBMIT = 'fal-ai/kling-video/v2.1/pro/image-to-video';
const KLING_BASE   = 'fal-ai/kling-video';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = process.env.FAL_API_KEY;
  if (!falKey) return res.status(500).json({ error: 'FAL_API_KEY not configured' });

  const { imageUrl, storyboard, prompt, language = 'English', brand = '', action = 'create', requestId } = req.body || {};
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
      const statusRes = await fetch(
        `https://queue.fal.run/${KLING_BASE}/requests/${requestId}/status`,
        { method: 'GET', headers: authHeaders }
      );
      const statusData = await safeJson(statusRes);
      console.log('Status HTTP:', statusRes.status, 'status:', statusData.status);

      if (statusData.status === 'COMPLETED') {
        const resultRes = await fetch(
          `https://queue.fal.run/${KLING_BASE}/requests/${requestId}`,
          { method: 'GET', headers: authHeaders }
        );
        const result = await safeJson(resultRes);
        const videoUrl = result.video?.url || result.video_url || null;
        console.log('COMPLETED - videoUrl:', videoUrl);
        return res.status(200).json({ status: 'COMPLETED', videoUrl });
      }

      if (statusData.status === 'FAILED') {
        return res.status(200).json({ status: 'FAILED', videoUrl: null });
      }

      return res.status(200).json({ status: statusData.status || 'IN_QUEUE', videoUrl: null });
    }

    // ── Create new video task ───────────────────────────────────────────────────
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });

    // ── Build prompt with visual anchoring + language consistency ───────────────
    let scenePrompt = '';
    if (storyboard && storyboard.length > 0) {
      scenePrompt = storyboard
        .map(s => `(${s.timing}) ${s.title}: ${s.description}`)
        .join(' ');
    } else {
      scenePrompt = prompt || 'Cinematic product advertisement, smooth camera movement.';
    }

    // Prepend visual anchoring instruction — keeps product consistent throughout
    const langInstruction = language !== 'English' ? `All text overlays and on-screen text must be in ${language} only. ` : '';
    const brandInstruction = brand ? `Brand: ${brand}. ` : '';
    // Strong visual anchor: reference image is the product — stay visually true to it
    const anchorInstruction = `This is a product advertisement video. The opening image shows the exact product being advertised — maintain 100% visual consistency with that product throughout every scene. Same product appearance, same colors, same brand. Do not introduce different products or unrelated visuals. ${langInstruction}${brandInstruction}`;

    const videoPrompt = `${anchorInstruction}${scenePrompt}`.slice(0, 2500);

    // Negative prompt — suppress scene drift, wrong languages, low quality
    const negativePrompt = `different product, substitute product, unrelated objects, scene replacement, Chinese text, Korean text, Japanese text, Arabic text, foreign language overlays, blur, distort, low quality, watermark, stock footage look`;

    // Fetch image and convert to base64
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
        negative_prompt: negativePrompt,
        duration: '10',
        aspect_ratio: '9:16',
        cfg_scale: 0.7,  // slightly higher = more prompt adherence
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
