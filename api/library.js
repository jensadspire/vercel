/**
 * /api/library — Persistent saved outputs library
 * POST { action: 'save', userId, entry }     → { ok, count }
 * POST { action: 'load', userId }            → { entries }
 * POST { action: 'delete', userId, entryId } → { ok }
 *
 * Storage: Upstash Redis  key = library:{userId}
 * Max 20 entries for Pro, 5 for free signed-in
 */

const MAX_PRO  = 20;
const MAX_FREE = 5;

async function redis(command, ...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Upstash not configured');
  const r = await fetch(`${url}/${command}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await r.json();
  return data.result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, userId, entry, entryId, plan = 'free' } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const key = `library:${userId}`;
  const maxEntries = plan === 'pro' ? MAX_PRO : MAX_FREE;

  try {
    if (action === 'load') {
      const raw = await redis('get', key);
      const entries = raw ? JSON.parse(raw) : [];
      return res.status(200).json({ entries });
    }

    if (action === 'save') {
      if (!entry) return res.status(400).json({ error: 'entry required' });
      const raw = await redis('get', key);
      const entries = raw ? JSON.parse(raw) : [];

      // Check limit
      if (entries.length >= maxEntries) {
        return res.status(200).json({ ok: false, limitReached: true, limit: maxEntries });
      }

      // Add with saved timestamp
      const newEntry = { ...entry, savedAt: new Date().toISOString(), starred: true };
      const updated = [newEntry, ...entries];
      await redis('set', key, JSON.stringify(updated));
      return res.status(200).json({ ok: true, count: updated.length });
    }

    if (action === 'delete') {
      if (!entryId) return res.status(400).json({ error: 'entryId required' });
      const raw = await redis('get', key);
      const entries = raw ? JSON.parse(raw) : [];
      const updated = entries.filter(e => e.id !== entryId);
      await redis('set', key, JSON.stringify(updated));
      return res.status(200).json({ ok: true, count: updated.length });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (err) {
    console.error('Library error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
