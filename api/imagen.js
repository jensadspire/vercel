/**
 * /api/imagen — Google Vertex AI Imagen 3 image generation
 * Accepts: { prompt, imageBase64?, imageMimeType? }
 * Returns: { imageUrl } (Vercel Blob permanent URL)
 */



// Get a Google OAuth2 access token from a service account key
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

  // Build JWT
  const enc = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${enc(header)}.${enc(payload)}`;

  // Sign with RS256 using the private key via Web Crypto
  const pemKey = key.private_key;
  const pemBody = pemKey.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const keyDer = Buffer.from(pemBody, 'base64');

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyDer,
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

  // Exchange JWT for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(`Auth failed: ${JSON.stringify(tokenData)}`);
  }
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

  const { prompt, imageBase64, imageMimeType = 'image/jpeg', imageUrl } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  // If imageUrl provided, fetch it server-side to avoid client payload limits
  let finalBase64 = imageBase64;
  let finalMimeType = imageMimeType;
  if (!finalBase64 && imageUrl) {
    try {
      const imgRes = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (imgRes.ok) {
        const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
        finalBase64 = imgBuffer.toString('base64');
        finalMimeType = imgRes.headers.get('content-type') || 'image/jpeg';
      }
    } catch(e) {
      console.warn('Could not fetch reference image:', e.message);
    }
  }

  const projectId = JSON.parse(saKey).project_id;

  try {
    // ── Get access token ──────────────────────────────────────────────────────
    const accessToken = await getAccessToken(saKey);

    // ── Build Imagen request ──────────────────────────────────────────────────
    const instances = [{ prompt }];

    // If a reference image is provided, add it for image editing / style transfer
    if (finalBase64) {
      instances[0].referenceImages = [{
        referenceType: 'REFERENCE_TYPE_STYLE',
        referenceImage: {
          bytesBase64Encoded: finalBase64,
          mimeType: finalMimeType,
        },
      }];
    }

    console.log('Calling Imagen for project:', projectId);
    const imagenRes = await fetch(
      `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/imagen-3.0-generate-001:predict`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          instances,
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
      return res.status(500).json({ error: 'Imagen returned non-JSON: ' + rawText.slice(0, 100) });
    }

    if (!imagenRes.ok) {
      console.error('Imagen error:', JSON.stringify(imagenData));
      return res.status(500).json({ error: imagenData.error?.message || 'Imagen generation failed', details: imagenData });
    }

    const b64 = imagenData.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) return res.status(500).json({ error: 'No image returned from Imagen' });

    // ── Upload to Vercel Blob for permanent URL ────────────────────────────────
    const { put } = await import('@vercel/blob');
    const imageBuffer = Buffer.from(b64, 'base64');
    const filename = `imagen-${Date.now()}.png`;

    const blob = await put(filename, imageBuffer, {
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
