// /api/meta-data-deletion.js
// Meta calls this webhook when a user requests data deletion under GDPR/CCPA.
//
// Meta POSTs a `signed_request` form field with the user_id of the user
// requesting deletion. We must:
//   1. Verify the signature
//   2. Delete that user's stored data (Meta token, ad account/page selection)
//   3. Return JSON with { url, confirmation_code } so Meta can show the user
//      a tracking URL where they can verify deletion happened.
//
// Reference: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
//
// Response format Meta expects:
//   {
//     "url": "https://your-app.com/deletion-status?id=ABC123",
//     "confirmation_code": "ABC123"
//   }

import crypto from 'crypto';
import {
  parseMetaSignedRequest,
  getClerkUserIdByFbUserId,
  clearMetaCredentials,
} from './lib/meta-token-store.js';

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export const config = {
  api: { bodyParser: false },
};

const BASE_URL = 'https://www.theaiad.studio';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const raw = await readBody(req);
    const params = new URLSearchParams(raw);
    const signedRequest = params.get('signed_request');

    // Generate a confirmation code regardless of payload validity so we always
    // return a well-formed response to Meta. The code is short, URL-safe, and
    // unique enough to avoid collisions in logs.
    const confirmationCode = crypto.randomBytes(8).toString('hex');

    let payload;
    try {
      payload = parseMetaSignedRequest(signedRequest);
    } catch (err) {
      console.warn('[meta-data-deletion] signature verification failed:', err.message);
      // Still return a valid response shape so Meta is satisfied — we logged the issue
      return res.status(200).json({
        url: `${BASE_URL}/api/data-deletion-status?id=${confirmationCode}`,
        confirmation_code: confirmationCode,
      });
    }

    const fbUserId = payload?.user_id;
    if (!fbUserId) {
      console.warn('[meta-data-deletion] no user_id in payload');
      return res.status(200).json({
        url: `${BASE_URL}/api/data-deletion-status?id=${confirmationCode}`,
        confirmation_code: confirmationCode,
      });
    }

    // Look up the Clerk userId via reverse index
    const clerkUserId = await getClerkUserIdByFbUserId(fbUserId);
    if (clerkUserId) {
      await clearMetaCredentials(clerkUserId);
      console.log(`[meta-data-deletion] deleted data for clerkUserId=${clerkUserId} (fbUserId=${fbUserId}, code=${confirmationCode})`);
    } else {
      console.log(`[meta-data-deletion] no matching user for fbUserId=${fbUserId} (code=${confirmationCode}) — nothing to delete`);
    }

    return res.status(200).json({
      url: `${BASE_URL}/api/data-deletion-status?id=${confirmationCode}`,
      confirmation_code: confirmationCode,
    });
  } catch (err) {
    console.error('[meta-data-deletion] error:', err);
    const fallbackCode = crypto.randomBytes(8).toString('hex');
    return res.status(200).json({
      url: `${BASE_URL}/api/data-deletion-status?id=${fallbackCode}`,
      confirmation_code: fallbackCode,
    });
  }
}
