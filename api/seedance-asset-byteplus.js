/**
 * /api/seedance-asset-byteplus — BytePlus ModelArk private asset library (AIGC virtual-portrait path).
 *
 * The legitimate way to animate a SYNTHETIC persona with Seedance: a fictional portrait is ingested into
 * an "AIGC" (Virtual Portrait) asset group, moderated → Active, then referenced by asset://<id> in the
 * normal /api/seedance-byteplus create call. The asset:// reference bypasses the input-image moderation
 * gate that blocks a raw persona URL (InputImageSensitiveContentDetected), because the library carries the
 * Dreamina Advanced Creation Rights for the asset. Synthetic/AIGC assets need NO liveness verification
 * (that's only for the LivenessFace / real-person tab).
 *
 * Two credential systems (do not mix):
 *   - asset MANAGEMENT (this file): BytePlus IAM AK/SK, OpenAPI V4 HMAC-SHA256 signature.
 *       host ark.ap-southeast-1.byteplusapi.com · service ark · region ap-southeast-1 · version 2024-01-01
 *       env: BYTEPLUS_MODELARK_ACCESS_KEY, BYTEPLUS_MODELARK_SECRET_KEY, (STS only) BYTEPLUS_MODELARK_SESSION_TOKEN
 *   - generation (/api/seedance-byteplus): the Bearer BYTEPLUS_API_DREAMINA_SEEDANCE_25_KEY. asset:// works
 *       there with only the Bearer key — no AK/SK needed to USE an asset, only to CREATE one.
 *
 * Actions (body.action):
 *   ensureGroup { subject }                       -> { groupId }     (reuse AIGC group named <subject>, else create)
 *   ingest      { imageUrl, subject?|groupId?, name? } -> { assetId, assetUri }   (auto-ensures group if subject given)
 *   assetStatus { assetId }                       -> { status, assetUri }  (poll until 'Active')
 *
 * Then generate: POST /api/seedance-byteplus { action:'create', imageUrls:['asset://<assetId>'], prompt, ... }
 *
 * Image limits (BytePlus): jpeg/png/webp/bmp/tiff/gif/heic; W:H ratio 0.4–2.5; each side 300–6000px; <30MB.
 * Isolated new file — touches nothing. Signer verified byte-for-byte against the official ark-mcp reference.
 */

import crypto from 'node:crypto';

const HOST = 'ark.ap-southeast-1.byteplusapi.com';
const REGION = 'ap-southeast-1';
const SERVICE = 'ark';
const VERSION = '2024-01-01';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest();
const rfc3986 = (v) => encodeURIComponent(v).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// BytePlus OpenAPI V4 (HMAC-SHA256). Returns the signed headers for one POST to /?Action=..&Version=..
function signedHeaders({ ak, sk, token, action, body, now }) {
  const xDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // YYYYMMDDTHHMMSSZ
  const short = xDate.slice(0, 8);
  const payloadHash = sha256hex(Buffer.from(body, 'utf8'));
  const query = Object.entries({ Action: action, Version: VERSION })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join('&');

  const hv = { 'content-type': 'application/json', host: HOST, 'x-content-sha256': payloadHash, 'x-date': xDate };
  if (token) hv['x-security-token'] = token;
  const names = Object.keys(hv).sort();
  const canonicalHeaders = names.map((n) => `${n}:${hv[n].trim()}\n`).join('');
  const signedNames = names.join(';');
  const canonicalRequest = ['POST', '/', query, canonicalHeaders, signedNames, payloadHash].join('\n');
  const scope = `${short}/${REGION}/${SERVICE}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, scope, sha256hex(Buffer.from(canonicalRequest, 'utf8'))].join('\n');
  let key = hmac(Buffer.from(sk, 'utf8'), short);
  key = hmac(key, REGION); key = hmac(key, SERVICE); key = hmac(key, 'request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');

  const headers = {
    'Content-Type': 'application/json',
    Host: HOST,
    'X-Date': xDate,
    'X-Content-Sha256': payloadHash,
    Authorization: `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedNames}, Signature=${signature}`,
  };
  if (token) headers['X-Security-Token'] = token;
  return { headers, query };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ak = process.env.BYTEPLUS_MODELARK_ACCESS_KEY;
  const sk = process.env.BYTEPLUS_MODELARK_SECRET_KEY;
  const token = process.env.BYTEPLUS_MODELARK_SESSION_TOKEN || '';
  if (!ak || !sk) return res.status(500).json({ error: 'BYTEPLUS_MODELARK_ACCESS_KEY / _SECRET_KEY not configured' });

  const {
    action = 'ingest',
    subject = 'AdspirePersona', groupId,          // ensureGroup / ingest
    imageUrl, name,                                // ingest
    assetId,                                        // assetStatus
    projectName = 'default',
  } = req.body || {};

  // One signed OpenAPI call. Returns Result on success; throws {code,message,raw} on envelope or HTTP error.
  const callArk = async (actn, payload) => {
    const body = JSON.stringify(payload);
    const { headers, query } = signedHeaders({ ak, sk, token, action: actn, body, now: new Date() });
    const r = await fetch(`https://${HOST}/?${query}`, { method: 'POST', headers, body });
    let d = {}; try { const t = await r.text(); d = t && t.trim() ? JSON.parse(t) : {}; } catch (_) {}
    const envErr = d?.ResponseMetadata?.Error;
    if (envErr || !r.ok) {
      const e = new Error(envErr?.Message || `HTTP ${r.status}`);
      e.code = envErr?.Code || String(r.status);
      e.raw = JSON.stringify(d).slice(0, 700);
      throw e;
    }
    return d?.Result || {};
  };

  const ensureGroup = async (name) => {
    // Reuse the single AIGC group named exactly <name>, else create it. (ListAssetGroups needs the Filter.)
    const list = await callArk('ListAssetGroups', { Filter: { GroupType: 'AIGC' }, MaxResults: 100, ProjectName: projectName });
    const items = list?.Items || [];
    const hit = items.find((g) => (g?.Name || '') === name);
    if (hit?.Id) return hit.Id;
    const made = await callArk('CreateAssetGroup', { Name: name, Description: 'AI Ad Studio synthetic persona', GroupType: 'AIGC', ProjectName: projectName });
    if (!made?.Id) throw Object.assign(new Error('CreateAssetGroup returned no Id'), { code: 'NoGroupId', raw: JSON.stringify(made).slice(0, 400) });
    return made.Id;
  };

  try {
    if (action === 'ensureGroup') {
      const gid = await ensureGroup(subject);
      return res.status(200).json({ groupId: gid });
    }

    if (action === 'ingest') {
      if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });
      const gid = groupId || (await ensureGroup(subject));
      const made = await callArk('CreateAsset', {
        GroupId: gid, URL: imageUrl, AssetType: 'Image',
        Name: name || ('persona-' + Date.now()), ProjectName: projectName,
      });
      if (!made?.Id) throw Object.assign(new Error('CreateAsset returned no Id'), { code: 'NoAssetId', raw: JSON.stringify(made).slice(0, 400) });
      return res.status(200).json({ assetId: made.Id, assetUri: 'asset://' + made.Id, groupId: gid });
    }

    if (action === 'assetStatus') {
      if (!assetId) return res.status(400).json({ error: 'assetId required' });
      const r = await callArk('GetAsset', { Id: assetId, ProjectName: projectName });
      const status = r?.Status || 'Unknown';
      return res.status(200).json({
        status, assetUri: 'asset://' + assetId,
        ...(status === 'Failed' ? { moderation: r?.Moderation || null } : {}),
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('[seedance-asset-byteplus]', action, err.code || '', err.message);
    return res.status(500).json({ error: err.message, code: err.code || null, ...(err.raw ? { detail: err.raw } : {}) });
  }
}
