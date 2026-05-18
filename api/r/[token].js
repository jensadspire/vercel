// api/r/[token].js
//
// GET /r/{token}
//
// Looks up the short-link record in Upstash, logs the click (fire-and-forget),
// appends UTM parameters to the destination URL, and issues a 302 redirect.
//
// If the token doesn't exist or has expired, falls through to PUBLIC_BASE_URL.

import { Redis } from '@upstash/redis';
import { appendUtm } from '../lib/slugify.js';

const KEY_PREFIX = 'shortlink:';
const redis = Redis.fromEnv();

export default async function handler(req, res) {
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://www.theaiad.studio';

  // --- Extract + validate token -----------------------------------------------
  const { token } = req.query;
  if (!token || typeof token !== 'string' || !/^[a-z0-9-]+$/i.test(token)) {
    return res.redirect(302, baseUrl);
  }

  // --- Lookup record ----------------------------------------------------------
  const key = KEY_PREFIX + token;
  let record;
  try {
    record = await redis.get(key);
  } catch (err) {
    console.error('[short-link] Upstash lookup failed:', err);
    return res.redirect(302, baseUrl);
  }

  if (!record || !record.destination) {
    return res.redirect(302, baseUrl);
  }

  // --- Fire-and-forget click logging ------------------------------------------
  const updatedRecord = {
    ...record,
    clicks: (record.clicks || 0) + 1,
    last_click_at: new Date().toISOString(),
  };
  redis.set(key, updatedRecord, { keepTtl: true }).catch((err) => {
    console.error('[short-link] click logging failed:', err);
  });

  // Optional: write a per-click event for richer analytics later.
  if (process.env.SHORT_LINK_LOG_CLICKS === 'true') {
    const eventKey = `shortlink:click:${token}:${Date.now()}`;
    const event = {
      token,
      recipient_email: record.recipient_email || null,
      campaign_id:     record.campaign_id     || null,
      clicked_at:      new Date().toISOString(),
      user_agent:      req.headers['user-agent'] || null,
      referer:         req.headers.referer       || null,
    };
    // 90-day TTL on individual click events
    redis.set(eventKey, event, { ex: 60 * 60 * 24 * 90 }).catch(() => {});
  }

  // --- Build final URL + redirect ---------------------------------------------
  const finalUrl = appendUtm(record.destination, record.utm || {});
  return res.redirect(302, finalUrl);
}
