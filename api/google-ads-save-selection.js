// /api/google-ads-save-selection.js
// Persists the user's chosen Google Ads customer ID (and optionally a manager
// account login_customer_id) to Upstash so future API calls know which account
// to publish to.
//
// Differences from meta-save-selection.js:
//   - No "page_id" equivalent (Google Ads has no concept of a Page; the
//     customer_id is the only required selection)
//   - login_customer_id is OPTIONAL — only used when the chosen customer_id
//     is a client account under a manager (MCC). For standalone customer
//     accounts it should be omitted (or equal to customer_id, which works too)

import { createClerkClient } from '@clerk/backend';
import { saveGoogleAdsSelection } from './lib/google-ads-token-store.js';

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY,
});

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

// Normalize customer_id: strip dashes, ensure it's a 10-digit string.
// Google sometimes shows IDs with dashes ("123-456-7890") but the API
// expects them without ("1234567890").
function normalizeCustomerId(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^0-9]/g, '');
  if (cleaned.length === 0) return null;
  return cleaned;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const userId = await authenticateUser(req);
    const { customerId, loginCustomerId } = req.body || {};

    const normalizedCustomerId = normalizeCustomerId(customerId);
    if (!normalizedCustomerId) {
      return res.status(400).json({ error: 'customerId required (10-digit Google Ads customer ID)' });
    }
    if (normalizedCustomerId.length !== 10) {
      return res.status(400).json({
        error: `customerId must be 10 digits, got ${normalizedCustomerId.length} ("${normalizedCustomerId}")`,
      });
    }

    // loginCustomerId is optional — only relevant for MCC-hosted accounts
    const normalizedLoginCustomerId = loginCustomerId ? normalizeCustomerId(loginCustomerId) : null;

    await saveGoogleAdsSelection({
      userId,
      customerId: normalizedCustomerId,
      loginCustomerId: normalizedLoginCustomerId,
    });

    return res.status(200).json({
      success: true,
      customerId: normalizedCustomerId,
      loginCustomerId: normalizedLoginCustomerId,
    });
  } catch (err) {
    console.error('[google-ads-save-selection] error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
