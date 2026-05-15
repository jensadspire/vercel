/**
 * /api/meta-campaigns — Fetch active/paused campaigns from the user's Meta ad account
 *
 * Token resolution:
 *   1. If the request includes a valid Clerk session token AND the user has
 *      connected their own Meta account, use their per-user credentials.
 *   2. Otherwise fall back to env-var Adspire credentials (demo mode).
 *
 * GET → { campaigns: [{ id, name, objective, status }] }
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

  // ── Resolve credentials: per-user (Upstash) if signed in, else env fallback ──
  let token, adAccountId;
  let credSource = 'env';

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
        if (creds?.accessToken && creds?.adAccountId) {
          token = creds.accessToken;
          adAccountId = creds.adAccountId;
          credSource = 'user';
          console.log(`[meta-campaigns] Using per-user credentials for ${userId} (ad_account=${adAccountId})`);
        }
      }
    } catch (err) {
      console.warn('[meta-campaigns] Clerk auth failed, falling back to env credentials:', err.message);
    }
  }

  if (!token) {
    token = process.env.META_ACCESS_TOKEN;
    adAccountId = process.env.META_AD_ACCOUNT_ID;
    console.log(`[meta-campaigns] Using env-var credentials (demo mode, ad_account=${adAccountId})`);
  }

  if (!token || !adAccountId) return res.status(500).json({ error: 'Meta credentials not configured' });

  try {
    const r = await fetch(
      `${FB_API}/${adAccountId}/campaigns?fields=id,name,objective,status&filtering=[{"field":"effective_status","operator":"IN","value":["ACTIVE","PAUSED"]}]&limit=50&access_token=${token}`
    );
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    return res.status(200).json({ campaigns: data.data || [] });
  } catch (err) {
    console.error('[meta-campaigns] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
