// /api/google-ads-connect.js
// Initiates the Google Ads OAuth flow.
//
// Flow:
//   1. Frontend POSTs here with the user's Clerk session
//   2. We verify the session, generate a CSRF state token, store it
//   3. We construct Google's OAuth consent URL with all required params
//   4. We return { url } — frontend redirects browser to it
//   5. User grants consent at Google
//   6. Google redirects to /api/google-ads-callback?code=xxx&state=xxx
//
// Why we don't redirect directly from here:
//   - This endpoint is called from frontend code, so a 302 response would
//     trigger a CORS preflight nightmare. Cleaner to return the URL and let
//     the frontend perform window.location = url.

import { createClerkClient } from '@clerk/backend';
import { generateOAuthState, saveOAuthState } from './lib/google-ads-token-store.js';

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY,
});

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

// Scopes we request:
//   - openid + email: needed to know which Google account connected (for UI display)
//   - adwords: the Google Ads API access (the actual goal)
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/adwords',
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ── Verify Clerk session ─────────────────────────────────────────────────
    // Supports both Authorization: Bearer <jwt> and x-clerk-session headers,
    // mirroring the pattern used by other /api/meta-* routes.
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

    // ── Determine redirect URI ───────────────────────────────────────────────
    // We prefer the env var (production), but allow override based on request
    // origin so that preview deployments and localhost dev still work.
    // CRITICAL: this URL must exactly match one of the redirect URIs registered
    // in Google Cloud Console, otherwise Google blocks the OAuth flow.
    const envRedirect = process.env.GOOGLE_ADS_REDIRECT_URI;
    const requestOrigin = req.headers.origin || (req.headers.host ? `https://${req.headers.host}` : null);
    const redirectUri = envRedirect || `${requestOrigin}/api/google-ads-callback`;

    // ── Generate CSRF state + persist ────────────────────────────────────────
    const state = generateOAuthState();
    await saveOAuthState({ state, userId });

    // ── Construct Google's OAuth consent URL ────────────────────────────────
    // Critical params for our use case:
    //   - access_type=offline      → tells Google to return a refresh_token
    //   - prompt=consent           → forces consent screen even if user previously
    //                                granted; ensures refresh_token comes back on
    //                                every reconnect (Google won't re-issue it
    //                                without re-consent if we skip this)
    //   - include_granted_scopes   → preserves previously-granted scopes if any
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });

    const url = `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
    return res.status(200).json({ url });

  } catch (err) {
    console.error('google-ads-connect error:', err.message);
    return res.status(500).json({ error: 'Failed to initiate Google Ads OAuth' });
  }
}
