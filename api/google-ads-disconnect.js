// /api/google-ads-disconnect.js
// Disconnects the user's Google Ads account by clearing all stored credentials
// (refresh token, access token, selection, etc.) from Upstash.
//
// Idempotent — calling on an already-disconnected user is a no-op success.
//
// Note: this only clears OUR stored tokens. The OAuth grant in the user's
// Google account remains active (they can see "AI Ad Studio" in their
// security settings at myaccount.google.com/permissions until they manually
// revoke). That's the correct behavior — we shouldn't be calling Google's
// revoke endpoint on disconnect, as the user may simply want to switch
// accounts or reconnect later.

import { createClerkClient } from '@clerk/backend';
import { clearGoogleAdsCredentials } from './lib/google-ads-token-store.js';

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ── Verify Clerk session ────────────────────────────────────────────────
    const sessionToken = req.headers.authorization?.replace(/^Bearer /, '')
      || req.headers['x-clerk-session'];
    if (!sessionToken) {
      return res.status(401).json({ error: 'Missing Authorization or x-clerk-session header' });
    }

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

    await clearGoogleAdsCredentials(userId);
    console.log(`google-ads-disconnect: cleared credentials for userId=${userId}`);
    return res.status(200).json({ success: true, connected: false });

  } catch (err) {
    console.error('google-ads-disconnect error:', err.message);
    return res.status(500).json({ error: 'Failed to disconnect' });
  }
}
