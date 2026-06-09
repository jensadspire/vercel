// /api/lib/google-ads-token-store.js
// Encrypted Google Ads OAuth token storage backed by Upstash Redis.
//
// Why this exists:
//   - Google Ads OAuth refresh tokens are bearer credentials. Anyone holding
//     a refresh token can mint access tokens, read ad data, create campaigns,
//     and spend budget. Storing them in plaintext anywhere is a P1 security
//     issue.
//   - We use AES-256-GCM (authenticated encryption — protects against tampering
//     in addition to confidentiality).
//   - The encryption key lives in env (GOOGLE_ADS_TOKEN_ENCRYPTION_KEY). If
//     rotated, all stored tokens become unreadable and users must reconnect.
//     That's an acceptable trade-off for the security gain.
//
// Differences from meta-token-store.js:
//   - Google issues TWO tokens: refresh_token (durable, encrypted-stored) and
//     access_token (~1 hour, also encrypted-stored as a cache).
//   - Google has no signed-request webhook system, so no parseSignedRequest.
//   - Google has no equivalent to fb_user_id reverse-index — revocations are
//     detected at API-call time (401 from token endpoint), not via webhook.
//   - Google's "ad account" equivalent is "customer_id" (sometimes paired with
//     login_customer_id for MCC/agency accounts).
//
// Storage schema (per user):
//   gads:{clerkUserId}:refresh_token         — encrypted refresh token (durable)
//   gads:{clerkUserId}:access_token          — encrypted access token (~1hr cache)
//   gads:{clerkUserId}:access_token_expires  — ISO timestamp when access token expires
//   gads:{clerkUserId}:customer_id           — chosen customer account (e.g. "1234567890")
//   gads:{clerkUserId}:login_customer_id     — manager (MCC) account, if any
//   gads:{clerkUserId}:google_user_email     — Google account email (for diagnostics + UI)
//   gads:{clerkUserId}:connected_at          — ISO timestamp of initial connection

import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;  // GCM standard
const AUTH_TAG_LENGTH = 16;

function getKey() {
  const hex = process.env.GOOGLE_ADS_TOKEN_ENCRYPTION_KEY;
  if (!hex) throw new Error('GOOGLE_ADS_TOKEN_ENCRYPTION_KEY env var not set');
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('GOOGLE_ADS_TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  return key;
}

export function encryptToken(plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Storage format: iv:tag:ciphertext (all hex)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptToken(encoded) {
  const parts = encoded.split(':');
  if (parts.length !== 3) throw new Error('Malformed encrypted token');
  const [ivHex, tagHex, ctHex] = parts;
  if (!ivHex || !tagHex) throw new Error('Malformed encrypted token');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ── Upstash REST helpers ────────────────────────────────────────────────────
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function upstash(command, ...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error('Upstash env vars not set');
  const r = await fetch(`${UPSTASH_URL}/${command}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  if (!r.ok) throw new Error(`Upstash ${command} failed: ${r.status}`);
  return r.json();
}

async function upstashSet(key, value) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error('Upstash env vars not set');
  // IMPORTANT: send the value as a raw text body, NOT JSON-stringified.
  // Upstash's REST API stores the body verbatim. If we use JSON.stringify(value)
  // here, the stored value gets wrapped in literal "..." quotes — which then
  // corrupts our `iv:tag:ciphertext` token format on decrypt (the leading `"`
  // makes ivHex invalid → "Invalid initialization vector" error).
  const r = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'text/plain' },
    body: String(value),
  });
  if (!r.ok) throw new Error(`Upstash SET failed: ${r.status}`);
  return r.json();
}

async function upstashSetWithExpiry(key, value, expirySeconds) {
  // Used for the CSRF state token (short-lived, ~10 min).
  if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error('Upstash env vars not set');
  const r = await fetch(`${UPSTASH_URL}/setex/${encodeURIComponent(key)}/${expirySeconds}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'text/plain' },
    body: String(value),
  });
  if (!r.ok) throw new Error(`Upstash SETEX failed: ${r.status}`);
  return r.json();
}

// ── Public API ──────────────────────────────────────────────────────────────

const KEY = (userId, suffix) => `gads:${userId}:${suffix}`;
const STATE_KEY = (state) => `gads:oauth_state:${state}`;

// ── OAuth state (CSRF protection) ───────────────────────────────────────────
// Before redirecting the user to Google's consent screen, we generate a random
// state token and store it (with the Clerk userId it's associated with) for
// 10 minutes. When Google redirects back with the same state, we verify it
// belongs to the expected user — preventing CSRF attacks where a malicious
// site could initiate an OAuth flow that links Google account A to victim B's
// Clerk session.

export function generateOAuthState() {
  return crypto.randomBytes(32).toString('hex');
}

export async function saveOAuthState({ state, userId }) {
  if (!state || !userId) throw new Error('state and userId required');
  // 10-minute TTL — the user must complete consent within this window
  await upstashSetWithExpiry(STATE_KEY(state), String(userId), 600);
}

export async function consumeOAuthState(state) {
  // Returns the userId associated with this state, or null if not found / expired.
  // Also DELETES the state after read — one-time use, prevents replay.
  if (!state) return null;
  const r = await upstash('get', STATE_KEY(state));
  if (!r.result) return null;
  try { await upstash('del', STATE_KEY(state)); } catch (_) { /* non-fatal */ }
  return r.result;
}

// ── Credentials (tokens + selection) ────────────────────────────────────────

export async function saveGoogleAdsCredentials({ userId, refreshToken, accessToken, accessTokenExpiresInSeconds, googleUserEmail }) {
  if (!userId) throw new Error('userId required');
  if (!refreshToken) throw new Error('refreshToken required');

  await upstashSet(KEY(userId, 'refresh_token'), encryptToken(refreshToken));

  if (accessToken) {
    const expires = new Date(Date.now() + (accessTokenExpiresInSeconds || 3600) * 1000).toISOString();
    await upstashSet(KEY(userId, 'access_token'), encryptToken(accessToken));
    await upstashSet(KEY(userId, 'access_token_expires'), expires);
  }

  if (googleUserEmail) {
    await upstashSet(KEY(userId, 'google_user_email'), String(googleUserEmail));
  }

  // Set connected_at only if not already set (preserves original connection date on reconnect)
  const existing = await upstash('get', KEY(userId, 'connected_at'));
  if (!existing.result) {
    await upstashSet(KEY(userId, 'connected_at'), new Date().toISOString());
  }
}

export async function getGoogleAdsCredentials(userId) {
  if (!userId) return null;
  const [refreshRes, accessRes, expiresRes, customerRes, loginCustomerRes, emailRes, connectedAtRes] = await Promise.all([
    upstash('get', KEY(userId, 'refresh_token')),
    upstash('get', KEY(userId, 'access_token')),
    upstash('get', KEY(userId, 'access_token_expires')),
    upstash('get', KEY(userId, 'customer_id')),
    upstash('get', KEY(userId, 'login_customer_id')),
    upstash('get', KEY(userId, 'google_user_email')),
    upstash('get', KEY(userId, 'connected_at')),
  ]);
  if (!refreshRes.result) return null;
  return {
    refreshToken: decryptToken(refreshRes.result),
    accessToken: accessRes.result ? decryptToken(accessRes.result) : null,
    accessTokenExpiresAt: expiresRes.result || null,
    customerId: customerRes.result || null,
    loginCustomerId: loginCustomerRes.result || null,
    googleUserEmail: emailRes.result || null,
    connectedAt: connectedAtRes.result || null,
  };
}

export async function saveGoogleAdsSelection({ userId, customerId, loginCustomerId }) {
  if (!userId) throw new Error('userId required');
  if (customerId) await upstashSet(KEY(userId, 'customer_id'), String(customerId));
  if (loginCustomerId) await upstashSet(KEY(userId, 'login_customer_id'), String(loginCustomerId));
}

export async function updateAccessToken({ userId, accessToken, expiresInSeconds }) {
  // Called after a refresh-token grant produces a new access token. Refresh
  // token stays the same; only the short-lived access token is updated.
  if (!userId) throw new Error('userId required');
  if (!accessToken) throw new Error('accessToken required');
  const expires = new Date(Date.now() + (expiresInSeconds || 3600) * 1000).toISOString();
  await upstashSet(KEY(userId, 'access_token'), encryptToken(accessToken));
  await upstashSet(KEY(userId, 'access_token_expires'), expires);
}

export async function clearGoogleAdsCredentials(userId) {
  if (!userId) throw new Error('userId required');
  await Promise.all([
    upstash('del', KEY(userId, 'refresh_token')),
    upstash('del', KEY(userId, 'access_token')),
    upstash('del', KEY(userId, 'access_token_expires')),
    upstash('del', KEY(userId, 'customer_id')),
    upstash('del', KEY(userId, 'login_customer_id')),
    upstash('del', KEY(userId, 'google_user_email')),
    upstash('del', KEY(userId, 'connected_at')),
  ]);
}

// ── Token exchange + refresh ────────────────────────────────────────────────
// After Google redirects the user back to /api/google-ads-callback with a
// `code` parameter, we exchange that code for a refresh + access token pair
// via Google's token endpoint. This requires the client_secret, hence is done
// server-side only.

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export async function exchangeCodeForTokens({ code, redirectUri }) {
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('GOOGLE_ADS_CLIENT_ID/SECRET env vars not set');

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const r = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await r.json();
  if (!r.ok || data.error) {
    throw new Error(`Token exchange failed: ${data.error || r.status} ${data.error_description || ''}`);
  }

  // Google's response shape:
  // { access_token, refresh_token, expires_in, scope, token_type, id_token }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,  // Only returned on first consent (with access_type=offline & prompt=consent)
    expiresInSeconds: data.expires_in || 3600,
    scope: data.scope,
    idToken: data.id_token,            // JWT containing user identity (email, sub, etc.)
  };
}

// Exchange a stored refresh token for a fresh access token.
// Returns the new access token + expiry. Refresh token itself is unchanged
// (Google's refresh tokens are long-lived; they only invalidate on user revoke).
export async function refreshAccessToken({ refreshToken }) {
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('GOOGLE_ADS_CLIENT_ID/SECRET env vars not set');

  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
  });

  const r = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await r.json();
  if (!r.ok || data.error) {
    // If refresh fails with invalid_grant, the user has revoked access in their
    // Google account settings. Caller should treat this as "disconnected" and
    // surface to user that they need to reconnect.
    const err = new Error(`Refresh failed: ${data.error || r.status} ${data.error_description || ''}`);
    err.code = data.error;
    throw err;
  }

  return {
    accessToken: data.access_token,
    expiresInSeconds: data.expires_in || 3600,
  };
}

// Convenience: get a usable access token, refreshing if expired.
// This is what API call sites should use — never call refresh directly.
export async function getValidAccessToken(userId) {
  const creds = await getGoogleAdsCredentials(userId);
  if (!creds) throw new Error('No Google Ads credentials for this user — connect first');

  // If access token still valid for >60 seconds, return as-is.
  // The 60s buffer prevents using a token that expires mid-request.
  if (creds.accessToken && creds.accessTokenExpiresAt) {
    const expiresAt = new Date(creds.accessTokenExpiresAt).getTime();
    if (expiresAt > Date.now() + 60_000) {
      return creds.accessToken;
    }
  }

  // Otherwise refresh
  const fresh = await refreshAccessToken({ refreshToken: creds.refreshToken });
  await updateAccessToken({
    userId,
    accessToken: fresh.accessToken,
    expiresInSeconds: fresh.expiresInSeconds,
  });
  return fresh.accessToken;
}

// ── Decode email from id_token (no signature verification — trust Google) ───
// The id_token from Google's response is a JWT. The middle segment (payload)
// is a base64url-encoded JSON containing user identity. We don't need to
// cryptographically verify it because we received it directly from Google over
// HTTPS in the token exchange response — there's no transit point an attacker
// could tamper with.
export function emailFromIdToken(idToken) {
  if (!idToken) return null;
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    return parsed.email || null;
  } catch (_) {
    return null;
  }
}
