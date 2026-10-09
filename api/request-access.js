/**
 * api/request-access.js — Beta access request intake (public, behind /invite).
 *
 * Stores a pending access request in Upstash Redis for admin review
 * (see api/approve-access.js). No email is sent here; Clerk sends the signup
 * invite once an admin approves.
 *
 * Storage:
 *   ZADD access:pending <ts> <email>   — review queue (dedups by email)
 *   SET  access:meta:<email> <json>    — request details
 * Abuse guards: email validation, honeypot field, best-effort per-IP rate limit.
 */

// ── Upstash Redis helper (REST API — same pattern as /api/generate) ──────────
async function redis(command, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { ok: false, result: null }; // not configured
  const res = await fetch(`${url}/${[command, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`redis ${command} http ${res.status}`);
  const data = await res.json();
  return { ok: true, result: data.result };
}

function validEmail(v) {
  return typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

const RL_MAX = 5;              // max requests per IP per window
const RL_WINDOW_SECS = 3600;   // 1 hour

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const email = (body.email || '').trim().toLowerCase();
    const honeypot = (body.website || '').trim();

    // Honeypot: real users never fill this hidden field. Pretend success, store nothing.
    if (honeypot) return res.status(200).json({ ok: true });

    if (!validEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

    // Per-IP rate limit (best-effort; silently skips if Redis is unreachable).
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    try {
      const rlKey = `access:rl:${ip}`;
      const n = await redis('INCR', rlKey);
      if (n.ok && n.result === 1) await redis('EXPIRE', rlKey, String(RL_WINDOW_SECS));
      if (n.ok && n.result > RL_MAX) return res.status(429).json({ error: 'Too many requests — please try again later.' });
    } catch (_) { /* rate-limit is best-effort, never blocks a genuine request */ }

    const z = await redis('ZADD', 'access:pending', String(Date.now()), email);
    if (!z.ok) return res.status(503).json({ error: 'Could not submit right now — please try again.' });
    await redis('SET', `access:meta:${email}`, JSON.stringify({ email, ts: Date.now(), ip, status: 'pending' }));

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[request-access] error:', err.message);
    return res.status(500).json({ error: 'Something went wrong — please try again.' });
  }
}
