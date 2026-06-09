// /api/google-ads-callback.js
// Handles Google's redirect after the user grants consent.
//
// Flow:
//   1. Google redirects browser here with ?code=xxx&state=xxx (or ?error=xxx)
//   2. We verify state (CSRF) → look up the Clerk userId who initiated this
//   3. We POST code to Google's token endpoint to get refresh + access tokens
//   4. We encrypt-store both tokens + extract user email from id_token
//   5. We redirect the user back to the app with ?googleAdsConnected=1
//
// Failure cases we handle:
//   - User clicked "Cancel" on consent screen → ?error=access_denied
//   - State token invalid/expired → CSRF protection rejection
//   - Code exchange fails → Google's error message
//   - No refresh_token in response → reconnect required (we force consent so
//     this shouldn't happen, but defensive coding)

import {
  consumeOAuthState,
  exchangeCodeForTokens,
  saveGoogleAdsCredentials,
  emailFromIdToken,
} from './lib/google-ads-token-store.js';

export default async function handler(req, res) {
  // Google uses GET for the redirect (with query params).
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  const { code, state, error: googleError, error_description } = req.query || {};

  // ── Determine where to redirect the user when we're done ─────────────────
  // We send them back to the app's root with a status query param. The frontend
  // reads this on mount and shows a connection status banner.
  const origin = req.headers.origin || (req.headers.host ? `https://${req.headers.host}` : 'https://www.theaiad.studio');
  const successUrl = `${origin}/?googleAdsConnected=1`;
  const errorUrl = (msg) => `${origin}/?googleAdsConnected=0&error=${encodeURIComponent(msg)}`;

  try {
    // ── Handle user-cancelled consent ────────────────────────────────────────
    if (googleError) {
      console.log(`google-ads-callback: user denied or Google error: ${googleError} ${error_description || ''}`);
      return res.redirect(302, errorUrl(googleError === 'access_denied' ? 'cancelled' : googleError));
    }

    if (!code || !state) {
      return res.redirect(302, errorUrl('missing_params'));
    }

    // ── Verify state token (CSRF protection) ─────────────────────────────────
    const userId = await consumeOAuthState(state);
    if (!userId) {
      console.warn('google-ads-callback: invalid or expired state token');
      return res.redirect(302, errorUrl('invalid_state'));
    }

    // ── Compute the redirect_uri we sent to Google ──────────────────────────
    // Must EXACTLY match what we sent during /api/google-ads-connect — otherwise
    // Google rejects the code exchange with redirect_uri_mismatch.
    const envRedirect = process.env.GOOGLE_ADS_REDIRECT_URI;
    const redirectUri = envRedirect || `${origin}/api/google-ads-callback`;

    // ── Exchange code for tokens ─────────────────────────────────────────────
    let tokens;
    try {
      tokens = await exchangeCodeForTokens({ code, redirectUri });
    } catch (err) {
      console.error('google-ads-callback: token exchange failed:', err.message);
      return res.redirect(302, errorUrl('token_exchange_failed'));
    }

    if (!tokens.refreshToken) {
      // This shouldn't happen because we force prompt=consent + access_type=offline,
      // but if Google ever changes behavior or the user has a corner-case account
      // state, surface the failure clearly rather than storing an unusable connection.
      console.error('google-ads-callback: no refresh_token in response — Google did not grant offline access');
      return res.redirect(302, errorUrl('no_refresh_token'));
    }

    // ── Extract user email from id_token (best-effort, non-blocking) ────────
    const googleUserEmail = emailFromIdToken(tokens.idToken);

    // ── Save credentials (encrypted) ────────────────────────────────────────
    await saveGoogleAdsCredentials({
      userId,
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
      accessTokenExpiresInSeconds: tokens.expiresInSeconds,
      googleUserEmail,
    });

    console.log(`google-ads-callback: success for userId=${userId} googleEmail=${googleUserEmail || 'unknown'}`);
    return res.redirect(302, successUrl);

  } catch (err) {
    console.error('google-ads-callback unexpected error:', err.message);
    return res.redirect(302, errorUrl('unexpected'));
  }
}
