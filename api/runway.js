/**
 * /api/runway — Runway Gen3 Turbo image-to-video
 * Runway requires https:// URLs (max 2048 chars) — no base64 accepted.
 * Strategy: if imageUrl is base64 or too long, upload to fal.ai storage first.
 */

const RUNWAY_API = 'https://api.dev.runwayml.com/v1';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const runwayKey = process.env.RUNWAY_API_KEY;
  const falKey = process.env.FAL_API_KEY;
  if (!runwayKey) return res.status(500).json({ error: 'Runway API key not configured' });

  const { imageUrl, prompt, duration = 10, action = 'create', taskId } = req.body || {};

  try {
    // ── Poll ─────────────────────────────────────────────────────────────────
    if (action === 'poll' && taskId) {
      const r = await fetch(`${RUNWAY_API}/tasks/${taskId}`, {
        headers: { 'Authorization': `Bearer ${runwayKey}`, 'X-Runway-Version': '2024-11-06' },
      });
      const data = await r.json();
      return res.status(200).json({
        status: data.status,
        videoUrl: data.output?.[0] || null,
        progress: data.progress || 0,
      });
    }

    // ── Create ────────────────────────────────────────────────────────────────
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });

    const motionPrompt = (prompt || 'Smooth cinematic camera movement, professional product advertisement').slice(0, 1000);

    // Determine if we need to upload the image
    const isBase64 = imageUrl.startsWith('data:');
    const isLongUrl = imageUrl.startsWith('https://') && imageUrl.length > 2048;
    const needsUpload = isBase64 || isLongUrl;

    let promptImage = imageUrl;

    if (needsUpload && falKey) {
      console.log('Image needs upload — base64:', isBase64, 'longUrl:', isLongUrl);
      try {
        let imgBuffer, contentType;

        if (isBase64) {
          // Parse base64 data URI
          const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            contentType = match[1];
            imgBuffer = Buffer.from(match[2], 'base64');
          }
        } else {
          // Fetch from URL
          const imgRes = await fetch(imageUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }
          });
          if (imgRes.ok) {
            imgBuffer = Buffer.from(await imgRes.arrayBuffer());
            contentType = imgRes.headers.get('content-type') || 'image/jpeg';
          }
        }

        if (imgBuffer) {
          const ext = (contentType || '').includes('png') ? 'png' : 'jpg';
          const filename = `runway-${Date.now()}.${ext}`;

          // Upload to fal.ai storage using multipart form
          const formData = new FormData();
          const blob = new Blob([imgBuffer], { type: contentType || 'image/jpeg' });
          formData.append('file', blob, filename);

          const uploadRes = await fetch('https://storage.fal.ai/upload', {
            method: 'POST',
            headers: { 'Authorization': `Key ${falKey}` },
            body: formData,
          });

          if (uploadRes.ok) {
            const uploadData = await uploadRes.json();
            const uploadedUrl = uploadData.url || uploadData.access_url;
            if (uploadedUrl && uploadedUrl.startsWith('https://') && uploadedUrl.length <= 2048) {
              promptImage = uploadedUrl;
              console.log('Uploaded to fal storage:', promptImage.slice(0, 80));
            }
          } else {
            const errText = await uploadRes.text();
            console.error('fal upload failed:', uploadRes.status, errText.slice(0, 200));
          }
        }
      } catch (uploadErr) {
        console.error('Upload error:', uploadErr.message);
      }
    }

    // Final validation
    if (!promptImage.startsWith('https://') || promptImage.length > 2048) {
      return res.status(400).json({
        error: 'Could not prepare a valid https:// image URL for Runway. Try selecting a different image.',
      });
    }

    console.log('Sending to Runway — URL length:', promptImage.length, 'starts:', promptImage.slice(0,40), 'isHttps:', promptImage.startsWith('https://'));

    const r = await fetch(`${RUNWAY_API}/image_to_video`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${runwayKey}`,
        'X-Runway-Version': '2024-11-06',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gen3a_turbo',
        promptImage,
        promptText: motionPrompt,
        duration,
        ratio: '768:1280',
        watermark: false,
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('Runway error:', JSON.stringify(data));
      return res.status(500).json({ error: data.message || 'Runway failed', detail: JSON.stringify(data) });
    }

    return res.status(200).json({ taskId: data.id, status: data.status });

  } catch (err) {
    console.error('Runway handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
