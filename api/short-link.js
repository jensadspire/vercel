// api/short-link.js
//
// POST /api/short-link
//
// Creates (or reuses) a short link mapped to a destination URL, with metadata
// for click tracking. Returns the token; the caller constructs the final
// short URL as `${BASE_URL}/r/${token}`.
//
// Request body:
// {
//   "product_name":     "Small Love Selection Box",
//   "campaign_code":    "2026-05-da",
//   "destination":      "https://www.theaiad.studio/?url=...&autorun=true&tab=meta",
//   "utm": { "source": "hs_email", "medium": "email", "campaign": "outreach_da_2026_05" },
//   "recipient_email":  "prospect@example.com",
//   "campaign_id":      "outreach_da_2026_05"
// }
//
// Response 200:
// { "token": "small-love-selection-box-2026-05-da", "reused": false, "short_url": "..." }
//
// Auth: protected by INTERNAL_API_TOKEN header. Set in Vercel env vars; pass
// from send-outreach.js as `x-internal-token`. Prevents random POSTs to this
// endpoint from creating short links.

import { Redis } from '@upstash/redis';
import { buildToken } from './lib/slugify.js';

const TTL_SECONDS = 60 * 60 * 24 * 90;       // 90 days
const KEY_PREFIX  = 'shortlink:';
const MAX_COLLISION_RETRIES = 20;

const redis = Redis.fromEnv();               // reads UPSTASH_REDIS_REST_URL + _TOKEN

export default async function handler(req, res) {
  // --- Method + auth checks ----------------------------------------------------
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const providedToken = req.headers['x-internal-token'];
  const expectedToken = process.env.INTERNAL_API_TOKEN;
  if (!expectedToken || providedToken !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // --- Validate input ---------------------------------------------------------
  const {
    product_name,
    campaign_code,
    destination,
    utm = {},
    recipient_email,
    campaign_id,
  } = req.body || {};

  if (!product_name || !campaign_code || !destination) {
    return res.status(400).json({
      error: 'Missing required fields: product_name, campaign_code, destination',
    });
  }

  // Reject obvious garbage destinations (must be valid http(s) URL)
  try {
    const u = new URL(destination);
    if (!/^https?:$/.test(u.protocol)) throw new Error('not http(s)');
  } catch {
    return res.status(400).json({ error: 'Invalid destination URL' });
  }

  // --- Build token + handle collisions ----------------------------------------
  const baseToken = buildToken(product_name, campaign_code);
  if (!baseToken) {
    return res.status(400).json({ error: 'Could not generate a valid token' });
  }

  let token = baseToken;
  let reused = false;

  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
    const key = KEY_PREFIX + token;
    const existing = await redis.get(key);

    if (!existing) {
      // Free slot — create new record
      const record = {
        destination,
        utm,
        recipient_email: recipient_email || null,
        campaign_id:     campaign_id     || null,
        created_at:      new Date().toISOString(),
        clicks:          0,
        last_click_at:   null,
      };
      await redis.set(key, record, { ex: TTL_SECONDS });
      break;
    }

    // Collision. If same destination + recipient, just reuse the existing token.
    if (existing.destination === destination &&
        (existing.recipient_email || null) === (recipient_email || null)) {
      reused = true;
      break;
    }

    // Real collision — append numeric suffix and try again
    token = `${baseToken}-${attempt + 2}`; // first retry is -2, then -3, ...
  }

  // --- Build response ---------------------------------------------------------
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://www.theaiad.studio';
  const short_url = `${baseUrl}/r/${token}`;

  return res.status(200).json({ token, reused, short_url });
}
