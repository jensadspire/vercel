/**
 * /api/imagen — Google Vertex AI Imagen 3 image generation/editing
 * Accepts: { prompt, imageBase64?, imageMimeType?, imageUrl? }
 * Returns: { imageUrl } (Vercel Blob permanent URL)
 *
 * If a reference image is provided, uses imagen-3.0-capability-001 with
 * REFERENCE_TYPE_SUBJECT to keep the product and place it in a new scene.
 * Otherwise falls back to imagen-3.0-generate-001 for text-to-image.
 */

async function getAccessToken(serviceAccountKey) {
  const key = typeof serviceAccountKey === 'string'
    ? JSON.parse(serviceAccountKey)
    : serviceAccountKey;

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const enc = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${enc(header)}.${enc(payload)}`;

  const pemBody = key.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    Buffer.from(pemBody, 'base64'),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    Buffer.from(signingInput)
  );

  const jwt = `${signingInput}.${Buffer.from(signature).toString('base64url')}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error(`Auth failed: ${JSON.stringify(tokenData)}`);
  return tokenData.access_token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const saKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!saKey) return res.status(500).json({ error: 'Google service account not configured' });

  const { prompt, imageBase64, imageMimeType = 'image/jpeg', imageUrl, sceneImageUrl } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const projectId = JSON.parse(saKey).project_id;

  try {
    // ── Resolve reference image ───────────────────────────────────────────────
    let finalBase64 = imageBase64;
    let finalMimeType = imageMimeType;

    if (!finalBase64 && imageUrl) {
      try {
        const imgRes = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (imgRes.ok) {
          finalBase64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64');
          finalMimeType = imgRes.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
        }
      } catch(e) {
        console.warn('Could not fetch reference image:', e.message);
      }
    }

    const accessToken = await getAccessToken(saKey);
    const hasReference = !!finalBase64;

    // ── Fetch scene image for remix mode ──────────────────────────────────────
    let sceneBase64 = null;
    let sceneMimeType = 'image/jpeg';
    if (sceneImageUrl) {
      try {
        const sceneRes = await fetch(sceneImageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (sceneRes.ok) {
          sceneBase64 = Buffer.from(await sceneRes.arrayBuffer()).toString('base64');
          sceneMimeType = sceneRes.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
        }
      } catch(e) {
        console.warn('Could not fetch scene image:', e.message);
      }
    }
    const isRemix = hasReference && !!sceneBase64;

    // ── Choose model and build request ────────────────────────────────────────
    // Remix mode: capability model with SUBJECT (product) + STYLE (scene)
    // Reference only: capability model with SUBJECT mode
    // Text only: generate model
    const model = (hasReference || isRemix)
      ? 'imagen-3.0-capability-001'
      : 'imagen-3.0-generate-001';

    const instance = { prompt };

    if (isRemix) {
      // Single SUBJECT reference — proven approach from v2
      // Scene passed via prompt description only, not as style reference
      instance.referenceImages = [
        {
          referenceId: 1,
          referenceType: 'REFERENCE_TYPE_SUBJECT',
          subjectImageConfig: { subjectType: 'SUBJECT_TYPE_PRODUCT' },
          referenceImage: { bytesBase64Encoded: finalBase64, mimeType: finalMimeType },
        },
      ];
    } else if (hasReference) {
      instance.referenceImages = [
        {
          referenceId: 1,
          referenceType: 'REFERENCE_TYPE_SUBJECT',
          subjectImageConfig: { subjectType: 'SUBJECT_TYPE_PRODUCT' },
          referenceImage: {
            bytesBase64Encoded: finalBase64,
            mimeType: finalMimeType,
          },
        },
      ];
    }

    console.log(`Calling Imagen model: ${model}, hasReference: ${hasReference}, isRemix: ${isRemix}`);

    const imagenRes = await fetch(
      `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/${model}:predict`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          instances: [instance],
          parameters: {
            sampleCount: 1,
            aspectRatio: '1:1',
            safetyFilterLevel: 'block_some',
            personGeneration: 'allow_adult',
          },
        }),
      }
    );

    let imagenData;
    const rawText = await imagenRes.text();
    try { imagenData = JSON.parse(rawText); } catch(_) {
      console.error('Imagen non-JSON response:', rawText.slice(0, 300));
      return res.status(500).json({ error: 'Imagen returned non-JSON: ' + rawText.slice(0, 200) });
    }

    if (!imagenRes.ok) {
      console.error('Imagen error:', JSON.stringify(imagenData));
      // If capability model fails, fall back to generate model
      if (hasReference && imagenData.error) {
        console.log('Capability model failed, falling back to generate model');
        const fallbackRes = await fetch(
          `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/imagen-3.0-generate-001:predict`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              instances: [{ prompt }],
              parameters: { sampleCount: 1, aspectRatio: '1:1', safetyFilterLevel: 'block_some' },
            }),
          }
        );
        const fallbackText = await fallbackRes.text();
        try { imagenData = JSON.parse(fallbackText); } catch(_) {
          return res.status(500).json({ error: 'Fallback also failed: ' + fallbackText.slice(0, 100) });
        }
        if (!fallbackRes.ok) return res.status(500).json({ error: imagenData.error?.message || 'Generation failed' });
      } else {
        return res.status(500).json({ error: imagenData.error?.message || 'Imagen generation failed' });
      }
    }

    const b64 = imagenData.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) return res.status(500).json({ error: 'No image returned from Imagen', raw: imagenData });

    // ── Upload to Vercel Blob ─────────────────────────────────────────────────
    const { put } = await import('@vercel/blob');
    const blob = await put(`imagen-${Date.now()}.png`, Buffer.from(b64, 'base64'), {
      access: 'public',
      contentType: 'image/png',
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    return res.status(200).json({ imageUrl: blob.url });

  } catch (err) {
    console.error('Imagen handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
