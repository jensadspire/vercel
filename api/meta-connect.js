// /api/meta-connect.js
// Called by the frontend after a user has connected their Facebook account
// via Clerk's OAuth flow (Account Linking).
//
// Flow:
//   1. Verify the user is authenticated (Clerk session)
//   2. Retrieve the short-lived Facebook access token from Clerk's Backend API
//   3. Exchange it for a long-lived (60-day) token via Meta's Graph API
//   4. Store the long-lived token (encrypted) + expiry + Meta user ID in Upstash
//   5. Return success + Meta user info so the frontend can show the picker
//
// This endpoint is idempotent — calling it twice for the same user just refreshes
// their stored token.

import { createClerkClient } from '@clerk/backend';
import {
  saveMetaCredentials,
  exchangeForLongLivedToken,
} from './lib/meta-token-store.js';

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    // ── 1. Authenticate the request via Clerk session token ──────────────────
    const sessionToken = req.headers.authorization?.replace(/^Bearer /, '')
      || req.headers['x-clerk-session'];
    if (!sessionToken) return res.status(401).json({ error: 'Missing Authorization or x-clerk-session header' });

    let userId;
    try {
      const session = await clerkClient.authenticateRequest(
        new Request(`https://${req.headers.host}${req.url}`, {
          headers: { Authorization: `Bearer ${sessionToken}` },
        })
      );
      const auth = session.toAuth();
      if (!auth?.userId) throw new Error('Session not signed in');
      userId = auth.userId;
    } catch (err) {
      return res.status(401).json({ error: 'Invalid Clerk session: ' + err.message });
    }

    // ── 2. Retrieve the Facebook OAuth access token from Clerk ──────────────
    let shortLivedToken;
    try {
      const oauthResponse = await clerkClient.users.getUserOauthAccessToken(
        userId,
        'oauth_facebook'
      );
      // Clerk returns { data: [{ token, scopes, ... }] }
      const tokens = oauthResponse?.data || oauthResponse || [];
      const fbToken = tokens[0];
      if (!fbToken?.token) {
        return res.status(400).json({
          error: 'No Facebook connection found. Please connect your Meta account first.',
          needsConnect: true,
        });
      }
      shortLivedToken = fbToken.token;
    } catch (err) {
      return res.status(500).json({ error: 'Failed to retrieve Facebook token from Clerk: ' + err.message });
    }

    // ── 3. Exchange for long-lived token (60-day) ───────────────────────────
    let longLived;
    try {
      longLived = await exchangeForLongLivedToken(shortLivedToken);
    } catch (err) {
      return res.status(500).json({ error: 'Token exchange failed: ' + err.message });
    }

    // ── 4. Fetch the Meta user ID + name for confirmation display ───────────
    let fbUser = { id: null, name: null };
    try {
      const r = await fetch(`https://graph.facebook.com/v21.0/me?fields=id,name&access_token=${longLived.accessToken}`);
      const data = await r.json();
      if (!data.error) fbUser = { id: data.id, name: data.name };
    } catch (_) {
      // Non-fatal — proceed without user info
    }

    // ── 5. Store encrypted token + metadata in Upstash ──────────────────────
    await saveMetaCredentials({
      userId,
      accessToken: longLived.accessToken,
      expiresInSeconds: longLived.expiresInSeconds,
      fbUserId: fbUser.id,
    });

    return res.status(200).json({
      success: true,
      connected: true,
      fbUser,
      expiresInSeconds: longLived.expiresInSeconds,
    });
  } catch (err) {
    console.error('[meta-connect] error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
