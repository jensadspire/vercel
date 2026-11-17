// /api/heygen-split.js — HeyGen split-screen composite (Route B, middle-ground).
//
// Composes a finished HeyGen avatar video (presenter, right panel) with the product
// image (left panel) into a single 1:1 side-by-side ad, then runs it through the SAME
// compliance stage every other engine uses (AI-label burn-in + C2PA sign + Blob store)
// via the shared labelAndStore(). Isolated endpoint — no shared-core edits.
//
//   POST { action:'compose', avatarVideoUrl, productImageUrl, brand?, overlayText? }
//     -> Rendi ffmpeg hstack pass -> labelAndStore
//     -> { ok, composed, url, labelled, signed, stored }
//
// Env reused (no new vars): RENDI_API_KEY, SIGNING_* , BLOB_READ_WRITE_TOKEN.
// FAIL-OPEN: if the compose pass fails we fall back to labelling the avatar video alone,
// so the user never loses their generation.

import { labelAndStore } from './_ai-label.js';

const RENDI_API_URL = 'https://api.rendi.dev/v1';
const RENDI_POLL_MS = 2500;
const RENDI_MAX_POLLS = 24;            // ~60s ceiling for a short clip
const RENDI_SUBMIT_TIMEOUT_MS = 15000;
const RENDI_429_RETRIES = 3;
const RENDI_429_WAIT_MS = 20000;       // Rendi quota is per-minute

// One Rendi pass: product image (left) + avatar video (right) -> 1080x1080.
// Image: contain + white pad (never crop the product). Video: cover + center-crop (fills panel).
// Returns the composed MP4 url, or null on any failure (caller falls back).
async function composeSideBySide(imageUrl, videoUrl) {
  const key = process.env.RENDI_API_KEY;
  if (!key) { console.error('[heygen-split] RENDI_API_KEY not set — cannot compose (fail-open)'); return null; }

  const filter =
    '[0:v]scale=540:1080:force_original_aspect_ratio=decrease,' +
    'pad=540:1080:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1[L];' +
    '[1:v]scale=540:1080:force_original_aspect_ratio=increase,crop=540:1080,setsar=1[R];' +
    '[L][R]hstack=inputs=2,format=yuv420p[v]';

  const ffmpeg_command =
    '-loop 1 -i {{in_1}} -i {{in_2}} -filter_complex "' + filter + '" ' +
    '-map "[v]" -map 1:a? -c:v libx264 -preset veryfast -c:a aac -shortest -movflags +faststart {{out_1}}';

  try {
    let submitRes, submitData;
    for (let attempt = 0; ; attempt++) {
      submitRes = await fetch(RENDI_API_URL + '/run-ffmpeg-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
        body: JSON.stringify({
          input_files: { in_1: imageUrl, in_2: videoUrl },
          output_files: { out_1: 'composed.mp4' },
          ffmpeg_command,
        }),
        signal: AbortSignal.timeout(RENDI_SUBMIT_TIMEOUT_MS),
      });
      submitData = await submitRes.json().catch(() => ({}));
      if (submitRes.status === 429 && attempt < RENDI_429_RETRIES) {
        console.error('[heygen-split] Rendi 429 — retry ' + (attempt + 1) + '/' + RENDI_429_RETRIES + ' in ' + (RENDI_429_WAIT_MS / 1000) + 's');
        await new Promise(r => setTimeout(r, RENDI_429_WAIT_MS));
        continue;
      }
      break;
    }
    if (!submitRes.ok) {
      console.error('[heygen-split] Rendi submit failed:', submitRes.status, JSON.stringify(submitData).slice(0, 300));
      return null;
    }
    const commandId = submitData.command_id || submitData.id || submitData.commandId;
    if (!commandId) {
      console.error('[heygen-split] Rendi submit returned no command_id:', JSON.stringify(submitData).slice(0, 300));
      return null;
    }

    for (let i = 0; i < RENDI_MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, RENDI_POLL_MS));
      const pollRes = await fetch(RENDI_API_URL + '/commands/' + commandId, { method: 'GET', headers: { 'X-API-KEY': key } });
      const pollData = await pollRes.json().catch(() => ({}));
      const status = (pollData.status || '').toUpperCase();
      if (status === 'SUCCESS' || status === 'SUCCEEDED' || status === 'COMPLETED') {
        const out =
          (pollData.output_files && pollData.output_files.out_1 && (pollData.output_files.out_1.storage_url || pollData.output_files.out_1)) ||
          (pollData.output_files && pollData.output_files[0] && pollData.output_files[0].storage_url) ||
          null;
        if (!out) { console.error('[heygen-split] Rendi SUCCESS but no output url:', JSON.stringify(pollData).slice(0, 300)); return null; }
        return typeof out === 'string' ? out : (out.storage_url || null);
      }
      if (status === 'FAILED' || status === 'ERROR') { console.error('[heygen-split] Rendi command failed:', JSON.stringify(pollData).slice(0, 300)); return null; }
    }
    console.error('[heygen-split] Rendi timed out after', RENDI_MAX_POLLS, 'polls — fail-open');
    return null;
  } catch (e) {
    console.error('[heygen-split] Rendi request error (fail-open):', e.message);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = body.action || '';

    if (action === 'compose') {
      const { avatarVideoUrl, productImageUrl } = body;
      if (!avatarVideoUrl) return res.status(400).json({ error: 'avatarVideoUrl required' });
      if (!productImageUrl) return res.status(400).json({ error: 'productImageUrl required' });

      const opts = { brand: body.brand || '', overlayText: body.overlayText || '' };

      // 1) compose side-by-side (fail-open -> label the avatar video alone)
      const composedUrl = await composeSideBySide(productImageUrl, avatarVideoUrl);
      const composed = !!composedUrl;
      const sourceForCompliance = composedUrl || avatarVideoUrl;
      if (!composed) console.error('[heygen-split] compose failed — labelling avatar video alone (fail-open)');

      // 2) shared compliance stage: AI label + C2PA sign + Blob (identical to every engine)
      const result = await labelAndStore(sourceForCompliance, 'heygen-split', opts);

      return res.status(200).json({
        ok: true,
        composed,
        url: result.url,
        labelled: result.labelled,
        signed: result.signed,
        stored: result.stored,
      });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    console.error('[heygen-split] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
