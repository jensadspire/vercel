/**
 * /api/imagen — Google Vertex AI image generation/editing
 * Accepts: { prompt, imageBase64?, imageMimeType?, imageUrl?, sceneImageUrl?, aspectRatio? }
 * Returns: { imageUrl }  (Vercel Blob permanent URL)
 *
 * Migrated from Imagen 3 (:predict) to Gemini 2.5 Flash Image ("Nano Banana",
 * google/gemini-2.5-flash-image) via :generateContent. The entire Imagen model
 * family was shut down on Vertex (Aug 2026), which is why imagen-3.0-generate-001
 * / imagen-3.0-capability-001 started 404-ing. One model now serves all modes:
 *   - text only        → prompt                              → generated image
 *   - reference image  → prompt + product image              → product kept, new scene
 *   - remix            → prompt + product image + scene image → product composited in
 *
 * The request/response contract is unchanged, so no frontend caller changes.
 * Auth + env vars (GOOGLE_SERVICE_ACCOUNT_KEY, BLOB_READ_WRITE_TOKEN) are untouched.
 */

const MODEL = 'gemini-2.5-flash-image';
const LOCATION = 'us-central1';

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

/** Fetch an image URL → { data: base64, mimeType }. Returns null on any failure. */
async function fetchAsBase64(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const data = Buffer.from(await r.arrayBuffer()).toString('base64');
    const mimeType = r.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
    return { data, mimeType };
  } catch (e) {
    console.warn('Could not fetch image:', String(url).slice(0, 80), e.message);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const saKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!saKey) return res.status(500).json({ error: 'Google service account not configured' });

  const { prompt, imageBase64, imageMimeType = 'image/jpeg', imageUrl, sceneImageUrl, aspectRatio = '1:1' } = req.body || {};

  // Keep the same five Imagen ratios so a bad caller value can never break a generation.
  const SUPPORTED_ASPECT_RATIOS = ['1:1', '9:16', '16:9', '3:4', '4:3'];
  const safeAspectRatio = SUPPORTED_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : '1:1';
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const projectId = JSON.parse(saKey).project_id;

  try {
    // ── Resolve input images (inline base64 wins, else fetch URL) ─────────────
    let product = null;
    if (imageBase64) product = { data: imageBase64, mimeType: imageMimeType };
    else if (imageUrl) product = await fetchAsBase64(imageUrl);

    let scene = null;
    if (sceneImageUrl) scene = await fetchAsBase64(sceneImageUrl);

    const hasReference = !!product;
    const isRemix = hasReference && !!scene;

    // ── Build generateContent parts: text prompt + any input images ───────────
    // Gemini composes directly from attached images — no SUBJECT/STYLE reference
    // config needed (that was Imagen's capability API). Product first, scene second.
    const parts = [{ text: prompt }];
    if (product) parts.push({ inlineData: { mimeType: product.mimeType, data: product.data } });
    if (scene) parts.push({ inlineData: { mimeType: scene.mimeType, data: scene.data } });

    const accessToken = await getAccessToken(saKey);
    console.log(`Calling ${MODEL}, hasReference: ${hasReference}, isRemix: ${isRemix}, ar: ${safeAspectRatio}`);

    const endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;

    const buildBody = (withImageConfig) => {
      const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
      if (withImageConfig) generationConfig.imageConfig = { aspectRatio: safeAspectRatio };
      return JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig,
        safetySettings: [
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      });
    };

    const callModel = (body) => fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body,
    });

    // Attempt with imageConfig (aspect ratio). If the model rejects that field,
    // retry once without it rather than hard-failing the whole generation.
    let genRes = await callModel(buildBody(true));
    let rawText = await genRes.text();
    if (!genRes.ok && /imageConfig|aspectRatio|aspect_ratio|Unknown name/i.test(rawText)) {
      console.warn('imageConfig not accepted, retrying without aspect ratio');
      genRes = await callModel(buildBody(false));
      rawText = await genRes.text();
    }

    let data;
    try { data = JSON.parse(rawText); } catch (_) {
      console.error('Gemini image non-JSON response:', rawText.slice(0, 300));
      return res.status(500).json({ error: 'Image model returned non-JSON: ' + rawText.slice(0, 200) });
    }

    if (!genRes.ok) {
      console.error('Gemini image error:', JSON.stringify(data));
      return res.status(500).json({ error: data.error?.message || 'Image generation failed' });
    }

    // ── Extract the first inline image part from the candidate ────────────────
    const partsOut = data.candidates?.[0]?.content?.parts || [];
    const imgPart = partsOut.find(p => p.inlineData?.data || p.inline_data?.data);
    const b64 = imgPart?.inlineData?.data || imgPart?.inline_data?.data;
    if (!b64) {
      // No image — usually a safety block or a text-only reply. Surface why.
      const finish = data.candidates?.[0]?.finishReason;
      const textOut = partsOut.find(p => p.text)?.text;
      console.error('No image in response. finishReason:', finish, '| text:', String(textOut).slice(0, 200), '| raw:', JSON.stringify(data).slice(0, 400));
      return res.status(500).json({ error: `No image returned (finishReason: ${finish || 'unknown'})` });
    }
    const outMime = imgPart.inlineData?.mimeType || imgPart.inline_data?.mimeType || 'image/png';
    const ext = /jpe?g/i.test(outMime) ? 'jpg' : 'png';

    // ── Upload to Vercel Blob ─────────────────────────────────────────────────
    const { put } = await import('@vercel/blob');
    const blob = await put(`imagen-${safeAspectRatio.replace(':', 'x')}-${Date.now()}.${ext}`, Buffer.from(b64, 'base64'), {
      access: 'public',
      contentType: outMime,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    return res.status(200).json({ imageUrl: blob.url });

  } catch (err) {
    console.error('Imagen handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
