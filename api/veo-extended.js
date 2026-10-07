/**
 * /api/veo-extended — VEO video EXTENSION flow via Vertex AI (staged, curl-testable).
 *
 * Proves the 8s→15s extension: generate base (scenes 1-2) → GCS, then extend it (scenes 3-4)
 * reading the base from GCS, output to GCS, pull → AI-label → Vercel Blob.
 *
 * Staged actions so each step is curl-testable in isolation:
 *   create-base  { imageUrl, prompt }        → { baseOp }
 *   poll-base    { baseOp }                   → { status, baseGcsUri } (when done)
 *   extend       { baseGcsUri, prompt }       → { extendOp }
 *   poll-extend  { extendOp }                 → { status, videoUrl } (pulls GCS → label → Blob)
 *
 * Separate from veo.js (which stays the working single-shot path).
 */

import crypto from 'node:crypto';
import { labelAndStore } from './_ai-label.js';

const LOCATION = process.env.VEO_LOCATION || 'us-central1';
const MODEL    = process.env.VEO_MODEL || 'veo-3.1-generate-001';
const BUCKET   = process.env.VEO_BUCKET || 'rsa-studio-veo-extended';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

// ── SA access token (native crypto JWT) — same as veo.js ──────────────────────
let _tok = { token: null, exp: 0 };
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_tok.token && _tok.exp - 300 > now) return _tok.token;
  const raw = process.env.GCP_SA_KEY;
  if (!raw) throw new Error('GCP_SA_KEY not configured');
  const sa = JSON.parse(raw);
  const privateKey = String(sa.private_key || '').replace(/\\n/g, '\n');
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const si = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: TOKEN_URI, iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(si).sign(privateKey).toString('base64url');
  const r = await fetch(TOKEN_URI, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${si}.${sig}` });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('token exchange failed: ' + (d.error_description || d.error || r.status));
  _tok = { token: d.access_token, exp: now + (d.expires_in || 3600) };
  return d.access_token;
}
function projectId() { try { return JSON.parse(process.env.GCP_SA_KEY).project_id; } catch { return null; } }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, imageUrl, referenceImages, prompt, baseOp, baseGcsUri, extendOp } = req.body || {};
  const safeJson = async (r) => { try { const t = await r.text(); return t && t.trim() ? JSON.parse(t) : {}; } catch { return {}; } };
  const project = projectId();
  if (!project) return res.status(500).json({ error: 'GCP_SA_KEY missing/invalid' });
  const BASE = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${project}/locations/${LOCATION}/publishers/google/models/${MODEL}`;

  try {
    const token = await getAccessToken();
    const H = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    const stamp = Date.now();

    // ── 1. CREATE BASE (scenes 1-2) → GCS ───────────────────────────────────────
    if (action === 'create-base') {
      // Accept EITHER referenceImages[] (1-3, multi-ref) OR a single imageUrl (back-compat).
      const urls = (Array.isArray(referenceImages) && referenceImages.length) ? referenceImages.slice(0, 3) : (imageUrl ? [imageUrl] : []);
      if (!urls.length) return res.status(400).json({ error: 'imageUrl or referenceImages required' });

      // fetch + fit each image to 9:16
      const fitOne = async (u) => {
        try {
          const ir = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }, signal: AbortSignal.timeout(10000) });
          if (!ir.ok) return null;
          const buf = Buffer.from(await ir.arrayBuffer());
          const sharp = (await import('sharp')).default;
          const fitted = await sharp(buf).flatten({ background: '#ffffff' }).resize(720, 1280, { fit: 'cover', position: 'centre' }).jpeg({ quality: 90 }).toBuffer();
          return fitted.toString('base64');
        } catch (e) { console.error('[veo-ext] image prep failed:', e.message); return null; }
      };
      const b64s = [];
      for (const u of urls) { const b = await fitOne(u); if (b) b64s.push(b); }
      if (!b64s.length) return res.status(400).json({ error: 'Could not fetch/prep product image(s)' });
      console.log('[veo-ext] base images:', b64s.length, '(multi-ref:', b64s.length > 1, ')');

      // Single image → image field (proven). Multiple → referenceImages array (proven in spike).
      const instance = (b64s.length === 1)
        ? { prompt: (prompt || '').slice(0, 2000), image: { bytesBase64Encoded: b64s[0], mimeType: 'image/jpeg' } }
        : { prompt: (prompt || '').slice(0, 2000), referenceImages: b64s.map(b => ({ image: { bytesBase64Encoded: b, mimeType: 'image/jpeg' }, referenceType: 'asset' })) };

      const outPrefix = `gs://${BUCKET}/input/${stamp}/`;
      const r = await fetch(`${BASE}:predictLongRunning`, { method: 'POST', headers: H, body: JSON.stringify({
        instances: [instance],
        parameters: { sampleCount: 1, durationSeconds: 8, aspectRatio: '9:16', storageUri: outPrefix },
      }) });
      const d = await safeJson(r);
      console.log('[veo-ext] create-base HTTP', r.status, d.name || JSON.stringify(d).slice(0, 200));
      if (!r.ok || !d.name) return res.status(500).json({ error: d.error?.message || 'base create failed', detail: JSON.stringify(d).slice(0, 400) });
      return res.status(200).json({ baseOp: d.name, outPrefix, status: 'IN_QUEUE' });
    }

    // ── 2. POLL BASE → base gs:// URI ───────────────────────────────────────────
    if (action === 'poll-base') {
      if (!baseOp) return res.status(400).json({ error: 'baseOp required' });
      const r = await fetch(`${BASE}:fetchPredictOperation`, { method: 'POST', headers: H, body: JSON.stringify({ operationName: baseOp }) });
      const op = await safeJson(r);
      if (!op.done) return res.status(200).json({ status: 'IN_PROGRESS' });
      if (op.error) return res.status(200).json({ status: 'FAILED', detail: JSON.stringify(op.error).slice(0, 400) });
      const resp = op.response || {};
      const sample = resp.videos?.[0] || resp.predictions?.[0] || null;
      const gcs = sample?.gcsUri || sample?.video?.uri || sample?.uri || null;
      console.log('[veo-ext] base done. gcsUri:', gcs, '| keys:', Object.keys(resp).join(','), sample ? '| sample:' + Object.keys(sample).join(',') : '');
      if (!gcs) {
        const raiBlocked = (resp.raiMediaFilteredCount > 0) || !!resp.raiMediaFilteredReasons;
        if (raiBlocked) console.error('[veo-ext] base RAI-FILTERED:', JSON.stringify(resp.raiMediaFilteredReasons || resp.raiMediaFilteredCount).slice(0, 300));
        return res.status(200).json({ status: raiBlocked ? 'FILTERED' : 'COMPLETED', baseGcsUri: null, detail: JSON.stringify(op).slice(0, 400) });
      }
      return res.status(200).json({ status: 'COMPLETED', baseGcsUri: gcs });
    }

    // ── 3. EXTEND (scenes 3-4) reading base from GCS → GCS ──────────────────────
    if (action === 'extend') {
      if (!baseGcsUri) return res.status(400).json({ error: 'baseGcsUri required' });
      const outPrefix = `gs://${BUCKET}/output/${stamp}/`;
      const r = await fetch(`${BASE}:predictLongRunning`, { method: 'POST', headers: H, body: JSON.stringify({
        instances: [{ prompt: (prompt || 'Continue the scene naturally, preserving protagonist, wardrobe, product, environment, lighting and camera style.').slice(0, 2000), video: { gcsUri: baseGcsUri, mimeType: 'video/mp4' } }],
        parameters: { sampleCount: 1, storageUri: outPrefix },
      }) });
      const d = await safeJson(r);
      console.log('[veo-ext] extend HTTP', r.status, d.name || JSON.stringify(d).slice(0, 300));
      if (!r.ok || !d.name) return res.status(500).json({ error: d.error?.message || 'extend create failed', detail: JSON.stringify(d).slice(0, 400) });
      return res.status(200).json({ extendOp: d.name, outPrefix, status: 'IN_QUEUE' });
    }

    // ── 4. POLL EXTEND → pull GCS → label → Blob ────────────────────────────────
    if (action === 'poll-extend') {
      if (!extendOp) return res.status(400).json({ error: 'extendOp required' });
      const r = await fetch(`${BASE}:fetchPredictOperation`, { method: 'POST', headers: H, body: JSON.stringify({ operationName: extendOp }) });
      const op = await safeJson(r);
      if (!op.done) return res.status(200).json({ status: 'IN_PROGRESS' });
      if (op.error) return res.status(200).json({ status: 'FAILED', detail: JSON.stringify(op.error).slice(0, 400) });
      const resp = op.response || {};
      const sample = resp.videos?.[0] || resp.predictions?.[0] || null;
      const gcs = sample?.gcsUri || sample?.video?.uri || sample?.uri || null;
      const b64 = sample?.bytesBase64Encoded || null;
      console.log('[veo-ext] extend done. gcsUri:', gcs, '| keys:', Object.keys(resp).join(','), sample ? '| sample:' + Object.keys(sample).join(',') : '');

      // Get the extended video bytes (from GCS or inline), upload raw to Blob, then label.
      let rawUrl = null;
      if (b64) {
        const buf = Buffer.from(b64, 'base64');
        const { put } = await import('@vercel/blob');
        const blob = await put(`veo-ext-raw-${stamp}.mp4`, buf, { access: 'public', contentType: 'video/mp4', token: process.env.BLOB_READ_WRITE_TOKEN });
        rawUrl = blob.url;
      } else if (gcs) {
        // Download from GCS via the JSON API (object get with alt=media), using the SA token.
        // gcs = gs://bucket/path → bucket + object
        const m = gcs.match(/^gs:\/\/([^/]+)\/(.+)$/);
        if (!m) return res.status(200).json({ status: 'COMPLETED', videoUrl: null, detail: 'unparseable gcsUri: ' + gcs });
        const [, bkt, obj] = m;
        const dl = await fetch(`https://storage.googleapis.com/storage/v1/b/${bkt}/o/${encodeURIComponent(obj)}?alt=media`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!dl.ok) return res.status(200).json({ status: 'COMPLETED', videoUrl: null, detail: 'GCS download failed ' + dl.status });
        const buf = Buffer.from(await dl.arrayBuffer());
        const { put } = await import('@vercel/blob');
        const blob = await put(`veo-ext-raw-${stamp}.mp4`, buf, { access: 'public', contentType: 'video/mp4', token: process.env.BLOB_READ_WRITE_TOKEN });
        rawUrl = blob.url;
      }
      if (!rawUrl) {
        const raiBlocked = (resp.raiMediaFilteredCount > 0) || !!resp.raiMediaFilteredReasons;
        if (raiBlocked) console.error('[veo-ext] extend RAI-FILTERED:', JSON.stringify(resp.raiMediaFilteredReasons || resp.raiMediaFilteredCount).slice(0, 300));
        return res.status(200).json({ status: raiBlocked ? 'FILTERED' : 'COMPLETED', videoUrl: null, detail: JSON.stringify(op).slice(0, 400) });
      }

      const { url: videoUrl, labelled } = await labelAndStore(rawUrl, 'veo');
      return res.status(200).json({ status: 'COMPLETED', videoUrl, labelled });
    }

    return res.status(400).json({ error: 'unknown action (use create-base|poll-base|extend|poll-extend)' });
  } catch (err) {
    console.error('[veo-ext] handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
