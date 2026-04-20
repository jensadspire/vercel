/**
 * /api/runway — Runway ML Gen-4 Turbo image-to-video
 * Runway API requires https:// URLs — base64 not accepted.
 * If image can't be fetched directly, upload to fal.ai storage first.
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

    const motionPrompt = (prompt || 'Smooth cinematic camera movement, professional product advertisement').slice(0, 1000);

    // ── Ensure we have a valid https:// URL for Runway ────────────────────────
    let promptImage = imageUrl;

    // If it's already a valid https URL, try using it directly first
    if (imageUrl.startsWith('https://')) {
      promptImage = imageUrl;
      // Check URL length — Runway max is 2048 chars
      if (promptImage.length > 2048) {
        promptImage = null; // will upload via fal.ai
      }
    } else {
      promptImage = null; // base64 or non-https — must upload
    }

    // If we need to upload, fetch the image and upload to fal.ai storage
    if (!promptImage && falKey) {
      try {
        console.log('Uploading image to fal.ai storage for Runway...');
        const imgRes = await fetch(imageUrl.startsWith('data:') ? imageUrl : imageUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }
        });
        if (imgRes.ok) {
          const imgBuffer = await imgRes.arrayBuffer();
          const imgBase64 = Buffer.from(imgBuffer).toString('base64');
          const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
          const ext = contentType.includes('png') ? 'png' : 'jpg';
          // Upload to fal.ai storage
          const uploadRes = await fetch('https://rest.alpha.fal.ai/storage/upload/base64', {
            method: 'POST',
            headers: {
              'Authorization': `Key ${falKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              content_type: contentType,
              file_name: `runway-input.${ext}`,
              data: imgBase64,
            }),
          });
          if (uploadRes.ok) {
            const uploadData = await uploadRes.json();
            promptImage = uploadData.url || uploadData.access_url || null;
            console.log('Uploaded to fal.ai:', promptImage);
          }
        }
      } catch (uploadErr) {
        console.error('Upload failed:', uploadErr.message);
      }
    }

    // Last resort — try passing the original URL directly
    if (!promptImage) {
      promptImage = imageUrl.startsWith('https://') ? imageUrl : null;
    }

    if (!promptImage) {
      return res.status(400).json({ error: 'Could not prepare image for Runway — needs a valid https:// URL' });
    }

    console.log('Runway promptImage URL length:', promptImage.length, 'starts with:', promptImage.slice(0, 30));

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
