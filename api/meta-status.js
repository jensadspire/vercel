// /api/meta-status.js
// Quick check: is the current user's Meta account connected, and if so,
// has the user picked an ad account + page yet?
//
// The frontend calls this on app load to decide what to render.

import { createClerkClient } from '@clerk/backend';
import { getMetaCredentials } from './lib/meta-token-store.js';

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

async function authenticateUser(req) {
  const sessionToken = req.headers.authorization?.replace(/^Bearer /, '')
    || req.headers['x-clerk-session'];
  if (!sessionToken) throw new Error('Missing Authorization or x-clerk-session header');
  const session = await clerkClient.authenticateRequest(
    new Request(`https://${req.headers.host}${req.url}`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    })
  );
  const auth = session.toAuth();
  if (!auth?.userId) throw new Error('Not signed in');
  return auth.userId;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const userId = await authenticateUser(req);
    const creds = await getMetaCredentials(userId);

    if (!creds?.accessToken) {
      return res.status(200).json({
        connected: false,
        selectionComplete: false,
      });
    }

    // Check if token is close to expiry (< 7 days)
    let needsRefresh = false;
    if (creds.expiresAt) {
      const expiresMs = new Date(creds.expiresAt).getTime();
      const remaining = expiresMs - Date.now();
      needsRefresh = remaining < 7 * 24 * 3600 * 1000;
    }

    return res.status(200).json({
      connected: true,
      selectionComplete: !!(creds.adAccountId && creds.pageId),
      adAccountId: creds.adAccountId,
      pageId: creds.pageId,
      fbUserId: creds.fbUserId,
      expiresAt: creds.expiresAt,
      needsRefresh,
    });
  } catch (err) {
    // For status checks, auth failures should return 200 with connected:false,
    // not 500 — unauthenticated users don't have a connection by definition.
    if (err.message.includes('Authorization') || err.message.includes('signed in')) {
      return res.status(200).json({ connected: false, selectionComplete: false, anonymous: true });
    }
    console.error('[meta-status] error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
