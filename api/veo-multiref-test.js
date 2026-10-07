/**
 * /api/veo-multiref-test — SPIKE: test VEO (Vertex) multi-reference ("Ingredients to Video").
 * Sends 2+ reference images (e.g. front + back) + a prompt, to learn whether VEO accepts
 * multi-image input and the exact request shape. Throwaway diagnostic — refine from errors.
 *
 *   create  { imageUrls: [frontUrl, backUrl], prompt }  → { requestId }
 *   poll    { action:'poll', requestId }                → { status, videoUrl }
 *
 * Reuses the SA-token auth + 9:16 crop from veo.js.
 */
import crypto from 'node:crypto';
import { labelAndStore } from './_ai-label.js';

const LOCATION = process.env.VEO_LOCATION || 'us-central1';
const MODEL    = process.env.VEO_MODEL || 'veo-3.1-generate-001';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

let _tok = { token: null, exp: 0 };
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_tok.token && _tok.exp - 300 > now) return _tok.token;
  const sa = JSON.parse(process.env.GCP_SA_KEY);
  const pk = String(sa.private_key || '').replace(/\\n/g, '\n');
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const si = `${b({ alg: 'RS256', typ: 'JWT' })}.${b({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: TOKEN_URI, iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(si).sign(pk).toString('base64url');
  const r = await fetch(TOKEN_URI, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${si}.${sig}` });
  const d = await r.json(); _tok = { token: d.access_token, exp: now + (d.expires_in || 3600) }; return d.access_token;
}
function projectId() { try { return JSON.parse(process.env.GCP_SA_KEY).project_id; } catch { return null; } }

async function fetchImg(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  const sharp = (await import('sharp')).default;
  const fitted = await sharp(buf).flatten({ background: '#ffffff' }).resize(720, 1280, { fit: 'cover', position: 'centre' }).jpeg({ quality: 90 }).toBuffer();
  return fitted.toString('base64');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, imageUrls, prompt, requestId } = req.body || {};
  const sj = async (r) => { try { const t = await r.text(); return t && t.trim() ? JSON.parse(t) : {}; } catch { return {}; } };
  const project = projectId();
  const BASE = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${project}/locations/${LOCATION}/publishers/google/models/${MODEL}`;

  try {
    const token = await getAccessToken();
    const H = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

    if (action === 'poll') {
      const r = await fetch(`${BASE}:fetchPredictOperation`, { method: 'POST', headers: H, body: JSON.stringify({ operationName: requestId }) });
      const op = await sj(r);
      if (!op.done) return res.status(200).json({ status: 'IN_PROGRESS' });
      if (op.error) return res.status(200).json({ status: 'FAILED', detail: JSON.stringify(op.error).slice(0, 400) });
      const s = op.response?.videos?.[0] || op.response?.predictions?.[0] || null;
      const b64 = s?.bytesBase64Encoded || null;
      if (!b64) return res.status(200).json({ status: 'COMPLETED', videoUrl: null, detail: JSON.stringify(op.response || op).slice(0, 400) });
      const { put } = await import('@vercel/blob');
      const blob = await put(`veo-multiref-${Date.now()}.mp4`, Buffer.from(b64, 'base64'), { access: 'public', contentType: 'video/mp4', token: process.env.BLOB_READ_WRITE_TOKEN });
      const { url, labelled } = await labelAndStore(blob.url, 'veo');
      return res.status(200).json({ status: 'COMPLETED', videoUrl: url, labelled });
    }

    // create — multi-reference
    if (!Array.isArray(imageUrls) || imageUrls.length < 1) return res.status(400).json({ error: 'imageUrls array required' });
    const imgs = [];
    for (const u of imageUrls.slice(0, 3)) { const b = await fetchImg(u); if (b) imgs.push(b); }
    if (!imgs.length) return res.status(400).json({ error: 'could not fetch any images' });
    console.log('[veo-multiref] images fetched:', imgs.length);

    // BEST-GUESS multi-image shape: referenceImages array (Vertex "Ingredients to Video").
    // If this shape is wrong, the error will tell us the expected field.
    const instance = {
      prompt: (prompt || 'Cinematic 9:16 product video using the provided reference images.').slice(0, 2000),
      referenceImages: imgs.map((b64, i) => ({
        image: { bytesBase64Encoded: b64, mimeType: 'image/jpeg' },
        referenceType: 'asset',   // guess; may need 'default'/'style'/etc.
      })),
    };

    const r = await fetch(`${BASE}:predictLongRunning`, { method: 'POST', headers: H, body: JSON.stringify({
      instances: [instance],
      parameters: { sampleCount: 1, durationSeconds: 8, aspectRatio: '9:16' },
    }) });
    const d = await sj(r);
    console.log('[veo-multiref] create HTTP', r.status, d.name || JSON.stringify(d).slice(0, 400));
    if (!r.ok || !d.name) return res.status(500).json({ error: d.error?.message || 'multiref create failed', detail: JSON.stringify(d).slice(0, 500) });
    return res.status(200).json({ requestId: d.name, status: 'IN_QUEUE' });

  } catch (err) {
    console.error('[veo-multiref] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
