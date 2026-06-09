// /api/google-ads-status.js
// Returns the current Google Ads connection state for the authenticated user.
//
// CRITICAL: This endpoint must NEVER return raw tokens — they're sensitive
// bearer credentials. Only metadata that's safe to expose to the browser:
//   - connected: true/false
//   - googleUserEmail (for "Connected as: foo@bar.com" UI)
//   - customerId (currently selected, if any)
//   - connectedAt (for display)
//
// Frontend uses this to:
//   - Show "Connect Google Ads" button when disconnected
//   - Show "Connected as foo@bar.com — change account / disconnect" when connected
//   - Decide which UI to render

import { createClerkClient } from '@clerk/backend';
import { getGoogleAdsCredentials } from './lib/google-ads-token-store.js';

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY,
});

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ── Verify Clerk session ────────────────────────────────────────────────
    // Mirrors the pattern used by other /api/meta-* routes.
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

    // ── Fetch credentials ───────────────────────────────────────────────────
    const creds = await getGoogleAdsCredentials(userId);
    if (!creds) {
      return res.status(200).json({ connected: false });
    }

    // ── Return safe metadata only — NEVER tokens ────────────────────────────
    return res.status(200).json({
      connected: true,
      googleUserEmail: creds.googleUserEmail,
      customerId: creds.customerId,
      loginCustomerId: creds.loginCustomerId,
      connectedAt: creds.connectedAt,
      selectionComplete: Boolean(creds.customerId),
    });

  } catch (err) {
    console.error('google-ads-status error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch status' });
  }
}
