// /api/heygen-lipsync.js — HeyGen voice + lipsync layer for the "live presenter" hybrid (variant b).
// Takes a presenter video (e.g. a Runway UGC clip of the saved avatar holding the product) and makes
// that presenter speak OUR localized script, lips matched. Isolated endpoint — no shared-core edits
// required to run (signC2PA is loaded dynamically and degrades gracefully if not yet exported).
//
//   POST { action:'tts', text, voiceId, language? }           -> { audioUrl, duration }
//   POST { action:'create', videoUrl, audioUrl, mode? }       -> { lipsyncId }
//   POST { action:'poll', lipsyncId }                         -> { status, videoUrl }
//   POST { action:'finalize', videoUrl, brand?, relabel? }    -> { url, labelled, signed, stored }
//        relabel !== false -> labelAndStore (label + C2PA + Blob) — use for an UNLABELLED input
//        relabel === false -> keep an already-present label; only C2PA-sign + store the new file
//
// Env: HEYGEN_API_KEY, SIGNING_* (C2PA via Cloud Run), BLOB_READ_WRITE_TOKEN.
// NOTE: HeyGen TTS language is ISO-639-1 (e.g. 'da'), NOT a regional tag ('da-DK' is rejected).

import { labelAndStore } from './_ai-label.js';

const HEYGEN_BASE = 'https://api.heygen.com';

async function heygen(path, { method = 'GET', body } = {}) {
  const key = process.env.HEYGEN_API_KEY;
  if (!key) throw new Error('HEYGEN_API_KEY is not set');
  const res = await fetch(HEYGEN_BASE + path, {
    method,
    headers: { 'x-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json && (json.message || (json.error && (json.error.message || json.error)) || json.detail)) || ('HTTP ' + res.status);
    throw new Error('HeyGen ' + path + ': ' + msg);
  }
  return json;
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

    // 1) Text -> speech (localized). language is ISO-639-1 (e.g. 'da'), auto-detected if omitted.
    if (action === 'tts') {
      const { text, voiceId } = body;
      if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
      if (!voiceId) return res.status(400).json({ error: 'voiceId required' });
      const payload = { model: 'heygen-voice-1', voice_id: voiceId, text: String(text).slice(0, 10000) };
      if (body.language) payload.language = String(body.language).slice(0, 8).toLowerCase();
      if (body.outputFormat) payload.output_format = body.outputFormat;
      const j = await heygen('/v3/models/audio/tts', { method: 'POST', body: payload });
      const d = (j && j.data) || j || {};
      const audioUrl = d.audio_url || d.audioUrl || (d.data && d.data.audio_url) || null;
      if (!audioUrl) return res.status(502).json({ error: 'No audio_url from TTS', raw: JSON.stringify(d).slice(0, 300) });
      return res.status(200).json({ ok: true, audioUrl, duration: d.duration || null });
    }

    // 2) Lipsync: re-animate the speaker in videoUrl to audioUrl.
    if (action === 'create') {
      const { videoUrl, audioUrl } = body;
      if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });
      if (!audioUrl) return res.status(400).json({ error: 'audioUrl required' });
      const payload = {
        video: { type: 'url', url: videoUrl },
        audio: { type: 'url', url: audioUrl },
        mode: body.mode || 'precision',
      };
      if (body.title) payload.title = String(body.title).slice(0, 120);
      if (typeof body.startTime === 'number') payload.start_time = body.startTime;
      if (typeof body.endTime === 'number') payload.end_time = body.endTime;
      const j = await heygen('/v3/lipsyncs', { method: 'POST', body: payload });
      const d = (j && j.data) || {};
      const lipsyncId = d.lipsync_id || d.id || null;
      if (!lipsyncId) return res.status(502).json({ error: 'No lipsync_id', raw: JSON.stringify(d).slice(0, 300) });
      return res.status(200).json({ ok: true, lipsyncId, status: d.status || 'pending' });
    }

    // 3) Poll lipsync status.
    if (action === 'poll') {
      const { lipsyncId } = body;
      if (!lipsyncId) return res.status(400).json({ error: 'lipsyncId required' });
      const j = await heygen('/v3/lipsyncs/' + encodeURIComponent(lipsyncId));
      const d = (j && j.data) || {};
      const videoUrl = d.video_url || d.output_url || d.url || (d.output && d.output.video_url) || null;
      const e = d.error;
      const errMsg = e ? (typeof e === 'string' ? e : (e.message || e.detail || JSON.stringify(e))) : null;
      return res.status(200).json({ ok: true, status: d.status || 'processing', videoUrl, error: errMsg });
    }

    // 4) Finalize: compliance (AI label + C2PA + Blob).
    if (action === 'finalize') {
      const { videoUrl } = body;
      if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });
      const brand = body.brand || '';

      // Default: label + sign + store (use when the lipsync INPUT was unlabelled).
      if (body.relabel !== false) {
        const result = await labelAndStore(videoUrl, 'heygen-lipsync', { brand });
        return res.status(200).json({ ok: true, ...result });
      }

      // relabel:false — keep an already-present visible label; only C2PA-sign + store the new file.
      let signed = false, stored = false, outUrl = videoUrl;
      try {
        let signedBuf = null;
        try {
          const mod = await import('./_ai-label.js');
          if (typeof mod.signC2PA === 'function') signedBuf = await mod.signC2PA(videoUrl, brand);
        } catch (sErr) { console.error('[heygen-lipsync] signC2PA unavailable:', sErr.message); }
        signed = !!signedBuf;
        let buf = signedBuf;
        if (!buf) {
          const vr = await fetch(videoUrl);
          if (!vr.ok) throw new Error('download ' + vr.status);
          buf = Buffer.from(await vr.arrayBuffer());
        }
        const { put } = await import('@vercel/blob');
        const blob = await put('heygen-lipsync-' + Date.now() + '.mp4', buf, {
          access: 'public', contentType: 'video/mp4', token: process.env.BLOB_READ_WRITE_TOKEN,
        });
        outUrl = blob.url; stored = true;
      } catch (err) {
        console.error('[heygen-lipsync] finalize sign/store failed:', err.message);
      }
      return res.status(200).json({ ok: true, url: outUrl, labelled: true, signed, stored });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    console.error('[heygen-lipsync] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
