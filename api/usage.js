/**
 * /api/usage — Track and check per-feature usage in Vercel KV
 * GET  ?userId=x&feature=y  → { count, limit, allowed, plan }
 * POST { userId, feature }  → { count, limit, allowed, plan } (increments count)
 */

// Monthly limits per plan per feature
const LIMITS = {
  rsa:    { anon: 10,  free: 999, pro: 999, past_due: 20  },
  meta:   { anon: 3,   free: 20,  pro: 999, past_due: 5   },
  imagen: { anon: 0,   free: 3,   pro: 999, past_due: 0   },
  batch:  { anon: 0,   free: 0,   pro: 999, past_due: 0   },
};

async function redis(command, ...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('KV not configured');
  const r = await fetch(`${url}/${command}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await r.json();
  return data.result;
}

async function getClerkPlan(userId) {
  if (!userId) return 'anon';
  const clerkSecret = process.env.CLERK_SECRET_KEY;
  if (!clerkSecret) return 'free';
  try {
    const r = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
      headers: { Authorization: `Bearer ${clerkSecret}` },
    });
    const user = await r.json();
    return user?.public_metadata?.plan || 'free';
  } catch { return 'free'; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId  = req.method === 'GET' ? req.query.userId  : req.body?.userId;
  const feature = req.method === 'GET' ? req.query.feature : req.body?.feature;

  if (!feature || !LIMITS[feature]) {
    return res.status(400).json({ error: 'Invalid feature' });
  }

  // Get plan
  const plan = userId ? await getClerkPlan(userId) : 'anon';
  const limit = LIMITS[feature][plan] ?? 0;

  // KV key: monthly bucket so limits reset each month
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const key = `usage:${userId || 'anon'}:${feature}:${month}`;

  try {
    let count = parseInt(await redis('GET', key) || '0', 10);
    const allowed = count < limit;

    if (req.method === 'POST' && allowed) {
      count = parseInt(await redis('INCR', key), 10);
      // Set expiry to 35 days so old keys auto-clean
      await redis('EXPIRE', key, '3024000');
    }

    return res.status(200).json({ count, limit, allowed, plan, feature });

  } catch (err) {
    console.error('Usage KV error:', err.message);
    // Fail open — don't block users if KV is down
    return res.status(200).json({ count: 0, limit, allowed: true, plan, feature, kvError: true });
  }
}
