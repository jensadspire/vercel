/**
 * /api/runway — Runway Gen3 Turbo image-to-video
 * Runway accepts:
 *   - https:// URLs (max 2048 chars) — but many CDNs block Runway's servers
 *   - data:image/...;base64,... URIs (max 5MB encoded = ~3.3MB raw)
 * Strategy: always fetch + re-encode as data URI for guaranteed delivery
 */

const RUNWAY_API = 'https://api.dev.runwayml.com/v1';
const MAX_BASE64_BYTES = 4 * 1024 * 1024; // 4MB encoded limit (safe under 5MB)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const runwayKey = process.env.RUNWAY_API_KEY;
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

    let promptImage;

    if (imageUrl.startsWith('data:')) {
      // Already a data URI — check size
      if (imageUrl.length > MAX_BASE64_BYTES) {
        return res.status(400).json({ error: 'Image too large for Runway (max ~3MB). Please select a smaller image.' });
      }
      promptImage = imageUrl;
      console.log('Using existing data URI, length:', imageUrl.length);
    } else {
      // Fetch from URL and convert to data URI
      console.log('Fetching image from:', imageUrl.slice(0, 80));
      try {
        const imgRes = await fetch(imageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; AdStudio/1.0)',
            'Accept': 'image/jpeg,image/png,image/webp,image/*',
          },
          signal: AbortSignal.timeout(10000),
        });

        if (!imgRes.ok) {
          throw new Error(`Image fetch failed: ${imgRes.status}`);
        }

        const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
        const contentType = imgRes.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
        const base64 = imgBuffer.toString('base64');
        const dataUri = `data:${contentType};base64,${base64}`;

        if (dataUri.length > MAX_BASE64_BYTES) {
          // Too large — try passing original https:// URL as fallback
          if (imageUrl.startsWith('https://') && imageUrl.length <= 2048) {
            console.log('Image too large for data URI, trying direct URL');
            promptImage = imageUrl;
          } else {
            return res.status(400).json({ error: 'Image too large for Runway (max ~3MB). Please select a smaller image.' });
          }
        } else {
          promptImage = dataUri;
          console.log('Converted to data URI, length:', dataUri.length, 'type:', contentType);
        }
      } catch (fetchErr) {
        // Fetch failed — try direct URL if it's a valid https URL
        console.error('Image fetch error:', fetchErr.message);
        if (imageUrl.startsWith('https://') && imageUrl.length <= 2048) {
          console.log('Fetch failed, falling back to direct URL');
          promptImage = imageUrl;
        } else {
          return res.status(400).json({ error: `Could not access image: ${fetchErr.message}` });
        }
      }
    }

    console.log('Sending to Runway — promptImage type:', promptImage.startsWith('data:') ? 'dataURI' : 'URL', 'length:', promptImage.length);

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
      console.error('Runway error:', JSON.stringify(data).slice(0, 500));
      return res.status(500).json({ error: data.message || 'Runway failed', detail: JSON.stringify(data).slice(0, 300) });
    }

    return res.status(200).json({ taskId: data.id, status: data.status });

  } catch (err) {
    console.error('Runway handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
