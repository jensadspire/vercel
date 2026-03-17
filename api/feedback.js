/**
 * /api/feedback — Store and retrieve output feedback scores
 * POST { action: 'submit', userId, outputId, format, url, score, comment } → { ok }
 * POST { action: 'get', userId, outputId }                                 → { score, comment }
 * POST { action: 'dashboard', adminKey }                                   → { entries }
 */

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

  const { action, userId, outputId, format, url, score, comment, adminKey } = req.body || {};

  try {
    // ── Submit feedback ───────────────────────────────────────────────────────
    if (action === 'submit') {
      if (!userId || !outputId || !score) return res.status(400).json({ error: 'Missing fields' });

      const entry = {
        userId, outputId, format, url, score,
        comment: comment || '',
        timestamp: new Date().toISOString(),
      };

      // Store per-user per-output (for showing existing score)
      await redis('set', `feedback:${userId}:${outputId}`, JSON.stringify(entry));

      // Append to global list for dashboard
      const listKey = 'feedback:all';
      const existing = await redis('get', listKey);
      const all = existing ? JSON.parse(existing) : [];
      // Remove any previous score from same user+output
      const filtered = all.filter(e => !(e.userId === userId && e.outputId === outputId));
      filtered.unshift(entry);
      await redis('set', listKey, JSON.stringify(filtered.slice(0, 500))); // keep last 500

      return res.status(200).json({ ok: true });
    }

    // ── Get existing score for an output ─────────────────────────────────────
    if (action === 'get') {
      if (!userId || !outputId) return res.status(400).json({ error: 'Missing fields' });
      const raw = await redis('get', `feedback:${userId}:${outputId}`);
      const entry = raw ? JSON.parse(raw) : null;
      return res.status(200).json({ score: entry?.score || null, comment: entry?.comment || '' });
    }

    // ── Dashboard — admin only ─────────────────────────────────────────────
    if (action === 'dashboard') {
      const validKey = process.env.VITE_ADMIN_KEY || process.env.ADMIN_KEY;
      if (!adminKey || adminKey !== validKey) return res.status(401).json({ error: 'Unauthorized' });
      const raw = await redis('get', 'feedback:all');
      const all = raw ? JSON.parse(raw) : [];
      return res.status(200).json({ entries: all });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (err) {
    console.error('Feedback error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
