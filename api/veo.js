/**
 * /api/veo — Google VEO via VERTEX AI (aiplatform.googleapis.com).
 *
 * Uses the Vertex AI path (not the Gemini API) because Vertex accepts enhancePrompt
 * (the prompt-rewriter that gives Flow-quality output) and honours aspectRatio/duration.
 *
 * Auth: service-account (GCP_SA_KEY env — full JSON) → signs a JWT with native crypto →
 * exchanges for an OAuth access token (scope cloud-platform). No external auth library.
 *
 * Contract matches the other engines so the frontend poll loop is unchanged:
 *   create (default): { requestId, status }   — requestId = Vertex operation name
 *   poll:             { status, videoUrl }     — videoUrl set only when finished
 *
 * VEO returns the video inline as base64 bytes (no storageUri) → we decode → labelAndStore
 * (AI-label + Vercel Blob) → return the Blob URL.
 */

import crypto from 'node:crypto';
import { labelAndStore } from './_ai-label.js';

const LOCATION = process.env.VEO_LOCATION || 'us-central1';
const MODEL    = process.env.VEO_MODEL || 'veo-3.1-generate-001';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

// ── Mint a Google OAuth access token from the service-account key (native crypto) ──
let _tokenCache = { token: null, exp: 0 };
async function getAccessToken() {
  // reuse a still-valid token (tokens last ~3600s; refresh 5 min early)
  const now = Math.floor(Date.now() / 1000);
  if (_tokenCache.token && _tokenCache.exp - 300 > now) return _tokenCache.token;

  const raw = process.env.GCP_SA_KEY;
  if (!raw) throw new Error('GCP_SA_KEY not configured');
  let sa;
  try { sa = JSON.parse(raw); } catch (e) { throw new Error('GCP_SA_KEY is not valid JSON'); }
  const clientEmail = sa.client_email;
  // env-var pastes sometimes escape the newlines in the PEM — normalise defensively
  const privateKey = String(sa.private_key || '').replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) throw new Error('GCP_SA_KEY missing client_email/private_key');

  const iat = now;
  const exp = now + 3600;
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: TOKEN_URI,
    iat, exp,
  };
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${b64url(header)}.${b64url(claim)}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKey).toString('base64url');
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch(TOKEN_URI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error('token exchange failed: ' + (data.error_description || data.error || res.status));
  }
  _tokenCache = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return data.access_token;
}

function projectId() {
  try { return JSON.parse(process.env.GCP_SA_KEY).project_id; } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageUrl, prompt, action = 'create', requestId } = req.body || {};

  const safeJson = async (r) => {
    try { const t = await r.text(); return t && t.trim() ? JSON.parse(t) : {}; }
    catch (_) { return {}; }
  };

  const project = projectId();
  if (!project) return res.status(500).json({ error: 'GCP_SA_KEY missing/invalid (no project_id)' });
  const BASE = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${project}/locations/${LOCATION}/publishers/google/models/${MODEL}`;

  try {
    const token = await getAccessToken();
    const authHeaders = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    // ── Poll existing operation ─────────────────────────────────────────────────
    if (action === 'poll' && requestId) {
      const opRes = await fetch(`${BASE}:fetchPredictOperation`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ operationName: requestId }),
      });
      const op = await safeJson(opRes);

      if (!op.done) return res.status(200).json({ status: 'IN_PROGRESS', videoUrl: null });
      if (op.error) {
        console.error('[veo] operation error:', JSON.stringify(op.error).slice(0, 300));
        return res.status(200).json({ status: 'FAILED', videoUrl: null });
      }

      // Vertex returns the video inline as base64 (no storageUri).
      // Shape: op.response.videos[0].bytesBase64Encoded  (also handle .predictions / .generatedSamples)
      const r = op.response || {};
      const sample = r.videos?.[0] || r.predictions?.[0] || r.generatedSamples?.[0] || null;
      const b64 = sample?.bytesBase64Encoded || sample?.video?.bytesBase64Encoded || sample?.bytes || null;
      const gcsUri = sample?.gcsUri || sample?.video?.uri || null;
      // Capture VEO's enhanced/rewritten prompt if the response exposes it (fields vary by API version).
      const enhancedPrompt = sample?.enhancedPrompt || sample?.rewrittenPrompt || sample?.prompt
        || r.enhancedPrompt || r.rewrittenPrompt
        || (Array.isArray(r.predictions) ? (r.predictions[0]?.enhancedPrompt || r.predictions[0]?.prompt) : null)
        || null;
      if (enhancedPrompt) console.log('[veo] ENHANCED prompt:', String(enhancedPrompt).slice(0, 1500));
      else console.log('[veo] no enhanced prompt field in response (keys:', Object.keys(r).join(',') + (sample ? ' | sample:' + Object.keys(sample).join(',') : '') + ')');

      if (!b64 && !gcsUri) {
        console.error('[veo] done but no video bytes/uri:', JSON.stringify(op).slice(0, 400));
        return res.status(200).json({ status: 'COMPLETED', videoUrl: null });
      }

      // Get the raw video into a Blob, then label+store (fail-open) like other engines.
      // labelAndStore takes a URL; for inline base64 we first upload the raw bytes to Blob,
      // then pass that URL through labelAndStore for the AI-label pass.
      let rawUrl = gcsUri;
      if (b64) {
        try {
          const buf = Buffer.from(b64, 'base64');
          const { put } = await import('@vercel/blob');
          const blob = await put(`veo-raw-${Date.now()}.mp4`, buf, {
            access: 'public', contentType: 'video/mp4', token: process.env.BLOB_READ_WRITE_TOKEN,
          });
          rawUrl = blob.url;
        } catch (e) {
          console.error('[veo] raw blob upload failed:', e.message);
          return res.status(200).json({ status: 'COMPLETED', videoUrl: null, error: 'store failed' });
        }
      }

      const { url: videoUrl, labelled } = await labelAndStore(rawUrl, 'veo');
      if (!labelled) console.error('[ai-label] Delivering UNLABELLED VEO video (Rendi unavailable)');
      return res.status(200).json({
        status: 'COMPLETED', videoUrl, labelled, enhancedPrompt,
        ...(labelled ? {} : { labelNote: "Your video is ready. We couldn't add the AI-content label on this one — you can re-run it, or add the label before publishing." }),
      });
    }

    // ── Create new video operation ──────────────────────────────────────────────
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });
    const motionPrompt = (prompt || 'Cinematic product advertisement, smooth camera movement, aspirational lighting.').slice(0, 2000);
    console.log('[veo] SENT prompt:', motionPrompt);

    // Fetch product image → base64 (flatten alpha → white, like kling.js).
    let imageB64 = null, imageMime = 'image/jpeg';
    try {
      const imgRes = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }, signal: AbortSignal.timeout(10000) });
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        let ct = (imgRes.headers.get('content-type') || 'image/jpeg').split(';')[0];
        try {
          const sharp = (await import('sharp')).default;
          const meta = await sharp(buf).metadata();
          if (meta.hasAlpha) { const flat = await sharp(buf).flatten({ background: '#ffffff' }).jpeg().toBuffer(); imageB64 = flat.toString('base64'); imageMime = 'image/jpeg'; }
          else { imageB64 = buf.toString('base64'); imageMime = ct || 'image/jpeg'; }
        } catch (_) { imageB64 = buf.toString('base64'); imageMime = ct || 'image/jpeg'; }
      }
    } catch (e) { console.error('[veo] image fetch failed:', e.message); }
    if (!imageB64) return res.status(400).json({ error: 'Could not fetch product image for VEO' });

    const submitRes = await fetch(`${BASE}:predictLongRunning`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        instances: [{
          prompt: motionPrompt,
          image: { bytesBase64Encoded: imageB64, mimeType: imageMime },
        }],
        parameters: {
          sampleCount: 1,
          durationSeconds: parseInt(process.env.VEO_DURATION || '8', 10),
          aspectRatio: '9:16',
          enhancePrompt: (process.env.VEO_ENHANCE || 'on') !== 'off',
        },
      }),
    });
    const submitData = await safeJson(submitRes);
    console.log('[veo] submit HTTP:', submitRes.status, 'op:', submitData.name || JSON.stringify(submitData).slice(0, 200));

    if (!submitRes.ok || !submitData.name) {
      return res.status(500).json({
        error: submitData.error?.message || 'VEO generation failed to start',
        detail: JSON.stringify(submitData).slice(0, 400),
      });
    }
    return res.status(200).json({ requestId: submitData.name, status: 'IN_QUEUE' });

  } catch (err) {
    console.error('[veo] handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
