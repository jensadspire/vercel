// /api/meta-deauthorize.js
// Meta calls this webhook when a user revokes our app's access from their
// Facebook settings (Settings → Apps and Websites → Remove app).
//
// Meta POSTs a `signed_request` form field (URL-encoded) containing the
// user_id of the user who just revoked. We verify the signature against our
// META_APP_SECRET, look up the corresponding Clerk userId via our reverse
// index, and delete that user's stored Meta credentials from Upstash.
//
// Response: 200 with empty body is sufficient. Meta only needs to know we
// received the call; the cleanup is fire-and-forget from Meta's perspective.
//
// Reference: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback

import {
  parseMetaSignedRequest,
  getClerkUserIdByFbUserId,
  clearMetaCredentials,
} from './lib/meta-token-store.js';

// Vercel serverless functions don't auto-parse form bodies — we need to read
// the raw body and parse it manually.
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export const config = {
  api: { bodyParser: false }, // disable Vercel's default JSON body parser
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const raw = await readBody(req);
    // Meta sends application/x-www-form-urlencoded with a single `signed_request` field
    const params = new URLSearchParams(raw);
    const signedRequest = params.get('signed_request');

    let payload;
    try {
      payload = parseMetaSignedRequest(signedRequest);
    } catch (err) {
      console.warn('[meta-deauthorize] signature verification failed:', err.message);
      // Return 200 so Meta doesn't retry endlessly, but log for monitoring
      return res.status(200).json({ ok: true, note: 'invalid signature' });
    }

    const fbUserId = payload?.user_id;
    if (!fbUserId) {
      console.warn('[meta-deauthorize] no user_id in payload');
      return res.status(200).json({ ok: true, note: 'no user_id' });
    }

    // Look up the Clerk userId via our reverse index
    const clerkUserId = await getClerkUserIdByFbUserId(fbUserId);
    if (!clerkUserId) {
      // Not an error — could be a user who never completed our flow or who
      // already had their data cleaned up. Log and return success.
      console.log(`[meta-deauthorize] no Clerk user found for fbUserId=${fbUserId}`);
      return res.status(200).json({ ok: true, note: 'no matching user' });
    }

    // Wipe their Meta credentials
    await clearMetaCredentials(clerkUserId);
    console.log(`[meta-deauthorize] cleared credentials for clerkUserId=${clerkUserId} (fbUserId=${fbUserId})`);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[meta-deauthorize] error:', err);
    // Always return 200 to webhooks to prevent retry storms; we already logged
    return res.status(200).json({ ok: false, error: err.message });
  }
}
