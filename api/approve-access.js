/**
 * api/approve-access.js — Admin review + approval for beta access requests.
 *
 * Guarded by x-admin-key === process.env.ADMIN_KEY (same guard as runway-recipe).
 * Paired with the admin view at /invite-admin.
 *
 *   GET  (or ?action=list)             → list pending requests (newest first)
 *   POST { action:'approve', email }   → Clerk createInvitation + move to approved
 *   POST { action:'reject',  email }   → remove from the queue
 *
 * On approval Clerk emails the prospect a unique signup link; nothing else sends mail.
 */
import { createClerkClient } from '@clerk/backend';

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

// ── Upstash Redis helper (REST API — same pattern as /api/generate) ──────────
async function redis(command, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { ok: false, result: null };
  const res = await fetch(`${url}/${[command, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`redis ${command} http ${res.status}`);
  const data = await res.json();
  return { ok: true, result: data.result };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey || (req.headers['x-admin-key'] || '') !== adminKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = req.method === 'GET'
      ? ((req.query && req.query.action) || 'list')
      : (body.action || '');

    if (action === 'list') {
      const z = await redis('ZRANGE', 'access:pending', '0', '-1', 'REV', 'WITHSCORES');
      const arr = (z.ok && Array.isArray(z.result)) ? z.result : [];
      const items = [];
      for (let i = 0; i < arr.length; i += 2) items.push({ email: arr[i], ts: Number(arr[i + 1]) });
      return res.status(200).json({ ok: true, pending: items });
    }

    const email = (body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'email required' });

    if (action === 'approve') {
      let invitationId = null;
      try {
        const inv = await clerk.invitations.createInvitation({ emailAddress: email, redirectUrl: 'https://theaiad.studio/' });
        invitationId = inv && inv.id ? inv.id : null;
      } catch (clerkErr) {
        return res.status(502).json({ error: 'Clerk invite failed: ' + clerkErr.message });
      }
      await redis('ZREM', 'access:pending', email);
      await redis('ZADD', 'access:approved', String(Date.now()), email);
      await redis('SET', `access:meta:${email}`, JSON.stringify({ email, status: 'approved', ts: Date.now(), invitationId }));
      return res.status(200).json({ ok: true, invitationId });
    }

    if (action === 'reject') {
      await redis('ZREM', 'access:pending', email);
      await redis('SET', `access:meta:${email}`, JSON.stringify({ email, status: 'rejected', ts: Date.now() }));
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    console.error('[approve-access] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
