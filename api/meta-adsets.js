/**
 * /api/meta-adsets — Fetch ad sets for a given campaign
 *
 * Token resolution:
 *   1. If the request includes a valid Clerk session token AND the user has
 *      connected their own Meta account, use their per-user credentials.
 *   2. Otherwise fall back to env-var Adspire credentials (demo mode).
 *
 * GET ?campaignId=xxx → { adsets: [{ id, name, status }] }
 */

import { createClerkClient } from '@clerk/backend';
import { getMetaCredentials } from './lib/meta-token-store.js';

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY,
});

const FB_API = 'https://graph.facebook.com/v21.0';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { campaignId } = req.query;
  if (!campaignId) return res.status(400).json({ error: 'Missing campaignId' });

  // ── Resolve token: per-user (Upstash) if signed in, else env fallback ──
  let token;
  const sessionToken = req.headers.authorization?.replace(/^Bearer /, '')
    || req.headers['x-clerk-session'];

  if (sessionToken) {
    try {
      const session = await clerkClient.authenticateRequest(
        new Request(`https://${req.headers.host}${req.url}`, {
          headers: { Authorization: `Bearer ${sessionToken}` },
        })
      );
      const auth = session.toAuth();
      const userId = auth?.userId;
      if (userId) {
        const creds = await getMetaCredentials(userId);
        if (creds?.accessToken) {
          token = creds.accessToken;
          console.log(`[meta-adsets] Using per-user credentials for ${userId}`);
        }
      }
    } catch (err) {
      console.warn('[meta-adsets] Clerk auth failed, falling back to env credentials:', err.message);
    }
  }

  if (!token) {
    token = process.env.META_ACCESS_TOKEN;
    console.log(`[meta-adsets] Using env-var credentials (demo mode)`);
  }

  if (!token) return res.status(500).json({ error: 'Meta credentials not configured' });

  try {
    const r = await fetch(
      `${FB_API}/${campaignId}/adsets?fields=id,name,status,daily_budget,targeting&filtering=[{"field":"effective_status","operator":"IN","value":["ACTIVE","PAUSED"]}]&limit=50&access_token=${token}`
    );
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    return res.status(200).json({ adsets: data.data || [] });
  } catch (err) {
    console.error('[meta-adsets] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
