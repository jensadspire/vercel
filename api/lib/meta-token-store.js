// /api/lib/meta-token-store.js
// Encrypted Meta access token storage backed by Upstash Redis.
//
// Why this exists:
//   - Meta access tokens are bearer credentials. Anyone holding the token can
//     publish ads, spend budget, read ad performance. Storing them in plaintext
//     in any datastore is a P1 security issue.
//   - We use AES-256-GCM (authenticated encryption — protects against tampering
//     in addition to confidentiality).
//   - The key lives in an env var (META_TOKEN_ENCRYPTION_KEY). If that single
//     secret is rotated, all stored tokens become unreadable; users must
//     reconnect Meta. That's an acceptable trade-off for the security gain.
//
// Storage schema (per user):
//   meta:{clerkUserId}:token         — encrypted access token
//   meta:{clerkUserId}:expires       — ISO timestamp when token expires
//   meta:{clerkUserId}:ad_account_id — chosen ad account (e.g. "act_12345")
//   meta:{clerkUserId}:page_id       — chosen Facebook page ID
//   meta:{clerkUserId}:fb_user_id    — Meta user ID (for refresh + diagnostics)

import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;  // GCM standard
const AUTH_TAG_LENGTH = 16;

function getKey() {
  const hex = process.env.META_TOKEN_ENCRYPTION_KEY;
  if (!hex) throw new Error('META_TOKEN_ENCRYPTION_KEY env var not set');
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('META_TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
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

// ── Public API ──────────────────────────────────────────────────────────────

const KEY = (userId, suffix) => `meta:${userId}:${suffix}`;
// Reverse index — lets webhooks (deauthorize, data deletion) find the Clerk
// userId given only the Facebook user ID that Meta sends us.
const FB_INDEX_KEY = (fbUserId) => `meta:fb_user:${fbUserId}`;

export async function saveMetaCredentials({ userId, accessToken, expiresInSeconds, fbUserId }) {
  if (!userId) throw new Error('userId required');
  if (!accessToken) throw new Error('accessToken required');
  const expires = new Date(Date.now() + (expiresInSeconds || 60 * 24 * 3600) * 1000).toISOString();
  await upstashSet(KEY(userId, 'token'), encryptToken(accessToken));
  await upstashSet(KEY(userId, 'expires'), expires);
  if (fbUserId) {
    await upstashSet(KEY(userId, 'fb_user_id'), String(fbUserId));
    // Reverse index for Meta webhooks
    await upstashSet(FB_INDEX_KEY(String(fbUserId)), String(userId));
  }
}

export async function getMetaCredentials(userId) {
  if (!userId) return null;
  const [tokenRes, expiresRes, accountRes, pageRes, fbUserRes] = await Promise.all([
    upstash('get', KEY(userId, 'token')),
    upstash('get', KEY(userId, 'expires')),
    upstash('get', KEY(userId, 'ad_account_id')),
    upstash('get', KEY(userId, 'page_id')),
    upstash('get', KEY(userId, 'fb_user_id')),
  ]);
  if (!tokenRes.result) return null;
  return {
    accessToken: decryptToken(tokenRes.result),
    expiresAt: expiresRes.result || null,
    adAccountId: accountRes.result || null,
    pageId: pageRes.result || null,
    fbUserId: fbUserRes.result || null,
  };
}

// Find the Clerk userId associated with a given Facebook user ID.
// Used by Meta's deauthorize + data-deletion webhooks which only send fb_user_id.
export async function getClerkUserIdByFbUserId(fbUserId) {
  if (!fbUserId) return null;
  const r = await upstash('get', FB_INDEX_KEY(String(fbUserId)));
  return r.result || null;
}

export async function saveMetaSelection({ userId, adAccountId, pageId }) {
  if (!userId) throw new Error('userId required');
  if (adAccountId) await upstashSet(KEY(userId, 'ad_account_id'), adAccountId);
  if (pageId) await upstashSet(KEY(userId, 'page_id'), pageId);
}

export async function clearMetaCredentials(userId) {
  if (!userId) throw new Error('userId required');
  // Read fb_user_id BEFORE deletion so we can also remove the reverse index
  let fbUserId = null;
  try {
    const r = await upstash('get', KEY(userId, 'fb_user_id'));
    fbUserId = r.result || null;
  } catch (_) { /* non-fatal */ }
  await Promise.all([
    upstash('del', KEY(userId, 'token')),
    upstash('del', KEY(userId, 'expires')),
    upstash('del', KEY(userId, 'ad_account_id')),
    upstash('del', KEY(userId, 'page_id')),
    upstash('del', KEY(userId, 'fb_user_id')),
  ]);
  if (fbUserId) {
    try { await upstash('del', FB_INDEX_KEY(String(fbUserId))); } catch (_) {}
  }
}

// ── Long-lived token exchange ───────────────────────────────────────────────
// Clerk gives us a short-lived (~1 hour) Facebook access token.
// We immediately exchange it for a long-lived (60-day) token before storing.
export async function exchangeForLongLivedToken(shortLivedToken) {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) throw new Error('META_APP_ID/SECRET env vars not set');
  const url = `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortLivedToken}`;
  const r = await fetch(url);
  const data = await r.json();
  if (data.error) throw new Error(`Token exchange failed: ${data.error.message}`);
  return {
    accessToken: data.access_token,
    expiresInSeconds: data.expires_in || 60 * 24 * 3600,
  };
}

// ── Meta signed_request verification ────────────────────────────────────────
// Meta's webhooks (deauthorize, data deletion, etc.) include a signed_request
// parameter — a base64url-encoded JSON payload prefixed with an HMAC-SHA256
// signature. This function verifies the signature against META_APP_SECRET and
// returns the parsed payload, or throws if the signature is invalid.
//
// Reference: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
//
// Returns the payload object on success; throws on bad signature or malformed input.
export function parseMetaSignedRequest(signedRequest) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) throw new Error('META_APP_SECRET env var not set');
  if (!signedRequest || typeof signedRequest !== 'string') {
    throw new Error('signed_request missing or malformed');
  }
  const [encodedSig, payload] = signedRequest.split('.');
  if (!encodedSig || !payload) throw new Error('signed_request must have two parts');

  // Base64url → base64 → bytes
  const b64urlToBuffer = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const sig = b64urlToBuffer(encodedSig);

  // Compute expected HMAC-SHA256 over the raw payload string using app secret
  const expected = crypto.createHmac('sha256', appSecret).update(payload).digest();

  // Constant-time comparison to prevent timing attacks
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) {
    throw new Error('signed_request signature mismatch — possible forgery');
  }

  // Decode and parse the payload JSON
  const payloadJson = b64urlToBuffer(payload).toString('utf8');
  const data = JSON.parse(payloadJson);
  if (data.algorithm !== 'HMAC-SHA256') {
    throw new Error(`Unexpected algorithm: ${data.algorithm}`);
  }
  return data;
}
