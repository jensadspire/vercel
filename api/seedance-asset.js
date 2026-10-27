/**
 * /api/seedance-asset — Seedance 2.x via the APIYI asset-library path (synthetic persona route).
 *
 * Bypasses fal's human-face block properly: a SYNTHETIC ("virtual avatar") portrait is ingested into the
 * asset library, reviewed → Active, then referenced by asset:// in generation. Per APIYI docs,
 * AI-generated photoreal portraits (no real-world counterpart) ingest as virtual avatars with NO
 * authorization step; only photos of real people need liveness verification. This is how MakeUGC-style
 * tools animate generated faces with Seedance.
 *
 * Two upstream services, two separate keys (do not mix them):
 *   - asset library:  https://icover.ai      Authorization: Bearer ICOVER_ASSET_KEY
 *   - video gen:      https://api.apiyi.com   Authorization: Bearer APIYI_TOKEN
 *
 * Actions (body.action):
 *   ingest      { imageUrl, label? }                                   -> { assetId }
 *   assetStatus { assetId }                                            -> { status }   (poll until 'Active')
 *   create      { assetIds[]|assetId, prompt, ratio?, duration?, resolution?, model? } -> { taskId }
 *   poll        { taskId }                                             -> { status, videoUrl? }
 *
 * Isolated new file — touches nothing. Spike posture: surfaces raw upstream payloads on failure so we can
 * diagnose the (new, third-party) API quickly.
 *
 * Env: ICOVER_ASSET_KEY, APIYI_TOKEN. (Blob/label reuse the existing stack.)
 */

import { labelAndStore } from './_ai-label.js';

const ICOVER = 'https://icover.ai';
const APIYI  = 'https://api.apiyi.com';
const DEFAULT_MODEL = 'doubao-seedance-2-0-260128'; // 2.0 (documented). 2.5 slug: override via body.model once confirmed.

export const config = { api: { bodyParser: { sizeLimit: '6mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const assetKey = process.env.ICOVER_ASSET_KEY;
  const apiyiToken = process.env.APIYI_TOKEN;

  const {
    action = 'create',
    imageUrl, label,                                   // ingest
    assetId, assetIds,                                 // assetStatus / create
    prompt, ratio = '9:16', duration = 5, resolution = '720p', model, // create
    taskId,                                            // poll
  } = req.body || {};

  const safeJson = async (r) => { try { const t = await r.text(); return t && t.trim() ? JSON.parse(t) : {}; } catch (_) { return {}; } };

  try {
    // ── 1. INGEST a (synthetic) portrait into the asset library ──
    if (action === 'ingest') {
      if (!assetKey) return res.status(500).json({ error: 'ICOVER_ASSET_KEY not configured' });
      if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });
      const r = await fetch(`${ICOVER}/api/asset-library/assets`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${assetKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl, label: label || ('persona-' + Date.now()), assetType: 'Image' }),
      });
      const d = await safeJson(r);
      const id = d?.Result?.Id || d?.result?.Id || d?.id || null;
      if (!r.ok || !id) return res.status(500).json({ error: 'asset ingest failed', detail: JSON.stringify(d).slice(0, 600) });
      return res.status(200).json({ assetId: id });
    }

    // ── 2. ASSET STATUS (poll until Active) ──
    if (action === 'assetStatus') {
      if (!assetKey) return res.status(500).json({ error: 'ICOVER_ASSET_KEY not configured' });
      if (!assetId) return res.status(400).json({ error: 'assetId required' });
      const r = await fetch(`${ICOVER}/api/asset-library/assets/${encodeURIComponent(assetId)}`, {
        headers: { Authorization: `Bearer ${assetKey}` },
      });
      const d = await safeJson(r);
      const status = d?.Result?.Status || d?.result?.Status || d?.status || 'Unknown';
      return res.status(200).json({ status, ...(status === 'Failed' ? { detail: JSON.stringify(d).slice(0, 400) } : {}) });
    }

    // ── 3. CREATE a generation task referencing the asset(s) ──
    if (action === 'create') {
      if (!apiyiToken) return res.status(500).json({ error: 'APIYI_TOKEN not configured' });
      const ids = Array.isArray(assetIds) ? assetIds : (assetId ? [assetId] : []);
      if (!ids.length) return res.status(400).json({ error: 'assetIds (or assetId) required' });
      if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt required' });
      const content = [
        { type: 'text', text: String(prompt).slice(0, 5000) },
        ...ids.map(id => ({ type: 'image_url', image_url: { url: String(id).startsWith('asset://') ? String(id) : ('asset://' + id) }, role: 'reference_image' })),
      ];
      const r = await fetch(`${APIYI}/seedance/api/v3/contents/generations/tasks`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiyiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || DEFAULT_MODEL, content, ratio, duration, resolution }),
      });
      const d = await safeJson(r);
      const tid = d?.id || d?.task_id || d?.data?.id || null;
      if (!r.ok || !tid) return res.status(500).json({ error: 'seedance task create failed', detail: JSON.stringify(d).slice(0, 600) });
      return res.status(200).json({ taskId: tid });
    }

    // ── 4. POLL the task until it yields a video ──
    if (action === 'poll') {
      if (!apiyiToken) return res.status(500).json({ error: 'APIYI_TOKEN not configured' });
      if (!taskId) return res.status(400).json({ error: 'taskId required' });
      const r = await fetch(`${APIYI}/seedance/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${apiyiToken}` },
      });
      const d = await safeJson(r);
      const status = d?.status || d?.data?.status || 'unknown';
      const rawVideoUrl = d?.content?.video_url || d?.data?.content?.video_url || d?.video_url || null;

      if (status === 'succeeded' || rawVideoUrl) {
        if (!rawVideoUrl) return res.status(200).json({ status: 'succeeded', videoUrl: null, raw: JSON.stringify(d).slice(0, 700) });
        const { url: videoUrl, labelled } = await labelAndStore(rawVideoUrl, 'seedance');
        if (!labelled) console.error('[ai-label] Delivering UNLABELLED Seedance(asset) video (Rendi unavailable)');
        return res.status(200).json({ status: 'succeeded', videoUrl, labelled });
      }
      if (status === 'failed') return res.status(200).json({ status: 'failed', videoUrl: null, raw: JSON.stringify(d).slice(0, 700) });
      return res.status(200).json({ status });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('[seedance-asset] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
