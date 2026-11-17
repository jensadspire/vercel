// /api/heygen-avatar.js — HeyGen "live-model" avatar track (Route B, HeyGen direct API).
//
// Isolated endpoint for the Personas module's licensed-avatar option. Separate from the old
// fal-based api/heygen.js (talking-head from a Pexels face) — this one uses HeyGen's OWN avatar
// library + generation, end-to-end on HeyGen's engine.
//
//   POST { action:'avatars' }                              → list HeyGen avatars + talking photos
//   POST { action:'voices' }                               → list voices
//   POST { action:'create', avatarId, script, voiceId,
//          aspectRatio?, resolution?, speed? }             → start a video → { videoId, status }
//   POST { action:'poll', videoId }                        → { status, videoUrl }
//
// Needs env HEYGEN_API_KEY (HeyGen dashboard → Settings → API). The frontend polls (same pattern
// as kling/seedance), so each call is short.
//
// NOTE (pre-launch): EU AI-Act labelling — run the returned videoUrl through the shared
// labelAndStore compliance stage before it's offered for download/publish, same as the other
// video engines. Left out of this slice to keep the endpoint standalone-testable.

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

    if (action === 'avatars') {
      const j = await heygen('/v2/avatars');
      const d = (j && j.data) || {};
      const avatars = (d.avatars || []).map((a) => ({
        avatarId: a.avatar_id,
        name: a.avatar_name || a.avatar_id,
        gender: a.gender || null,
        preview: a.preview_image_url || a.preview_url || null,
        premium: !!a.premium,
      }));
      const talkingPhotos = (d.talking_photos || []).map((t) => ({
        avatarId: t.talking_photo_id,
        name: t.talking_photo_name || t.talking_photo_id,
        preview: t.preview_image_url || null,
        kind: 'talking_photo',
      }));
      return res.status(200).json({ ok: true, avatars, talkingPhotos });
    }

    if (action === 'voices') {
      const j = await heygen('/v2/voices');
      const d = (j && j.data) || {};
      const voices = (d.voices || []).map((v) => ({
        voiceId: v.voice_id,
        name: v.name || v.voice_id,
        language: v.language || null,
        gender: v.gender || null,
        preview: v.preview_audio || null,
      }));
      return res.status(200).json({ ok: true, voices });
    }

    if (action === 'create') {
      const { avatarId, script, voiceId } = body;
      if (!avatarId) return res.status(400).json({ error: 'avatarId required' });
      if (!script || !String(script).trim()) return res.status(400).json({ error: 'script required' });
      const payload = {
        type: 'avatar',
        avatar_id: avatarId,
        script: String(script).slice(0, 3000),
        aspect_ratio: body.aspectRatio || '9:16',
        resolution: body.resolution || '1080p',
        engine: { type: 'avatar_iv' },
      };
      if (voiceId) payload.voice_id = voiceId;
      payload.voice_settings = { speed: Math.min(1.5, Math.max(0.5, Number(body.speed) || 1)) };
      const j = await heygen('/v3/videos', { method: 'POST', body: payload });
      const d = (j && j.data) || {};
      return res.status(200).json({ ok: true, videoId: d.video_id || null, status: d.status || 'waiting' });
    }

    if (action === 'poll') {
      const { videoId } = body;
      if (!videoId) return res.status(400).json({ error: 'videoId required' });
      const j = await heygen('/v3/videos/' + encodeURIComponent(videoId));
      const d = (j && j.data) || {};
      return res.status(200).json({
        ok: true,
        status: d.status || 'processing',
        videoUrl: d.video_url || d.video_url_caption || null,
        error: d.error || null,
      });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    console.error('[heygen-avatar] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
