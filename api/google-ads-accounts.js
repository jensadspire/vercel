// /api/google-ads-accounts.js
// Returns the authenticated user's accessible Google Ads customer accounts so
// the frontend can show a picker.
//
// Two-step Google Ads pattern:
//   1. listAccessibleCustomers(refreshToken) → returns array of resource names
//      ("customers/1234567890") for every customer the OAuth user can access
//   2. For each customer ID, query the customer resource to get name/currency/
//      timezone/manager flag. This is one query per customer.
//
// Note: query in step 2 requires login_customer_id when the customer is a
// CLIENT account under an MCC. For top-level customers (manager OR standalone)
// no login_customer_id is needed. We handle the common case here; cross-MCC
// queries can be added later if needed.

import { createClerkClient } from '@clerk/backend';
import { GoogleAdsApi } from 'google-ads-api';
import {
  getGoogleAdsCredentials,
  refreshAccessToken,
  updateAccessToken,
} from './lib/google-ads-token-store.js';

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

// Strip "customers/" prefix from resource names like "customers/1234567890"
function customerIdFromResourceName(resourceName) {
  if (!resourceName) return null;
  const match = String(resourceName).match(/customers\/(\d+)/);
  return match ? match[1] : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const userId = await authenticateUser(req);

    // ── Retrieve stored credentials ─────────────────────────────────────────
    const creds = await getGoogleAdsCredentials(userId);
    if (!creds?.refreshToken) {
      return res.status(400).json({ error: 'Google Ads account not connected', needsConnect: true });
    }

    // ── Initialize the Google Ads API client ────────────────────────────────
    // Using process.env values directly here, NOT creds.accessToken — the
    // library manages access tokens internally using the refresh token.
    const client = new GoogleAdsApi({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    });

    // ── Step 1: List accessible customers ───────────────────────────────────
    // This call uses the refresh token to get a fresh access token internally,
    // then queries Google Ads for all customers the user can see.
    let resourceNames = [];
    try {
      const result = await client.listAccessibleCustomers(creds.refreshToken);
      resourceNames = result.resource_names || [];
    } catch (err) {
      // Common failures:
      //  - DEVELOPER_TOKEN_NOT_APPROVED → developer token still in Pending state
      //  - INVALID_REFRESH_TOKEN → user revoked access in their Google account
      //  - USER_PERMISSION_DENIED → token lacks /adwords scope
      const code = err.code || err.message || 'unknown';
      console.error('[google-ads-accounts] listAccessibleCustomers failed:', code, err.message);

      if (String(err.message || '').toLowerCase().includes('refresh') ||
          String(err.message || '').toLowerCase().includes('invalid_grant')) {
        return res.status(401).json({
          error: 'Google Ads connection expired. Please reconnect your Google Ads account.',
          needsReconnect: true,
        });
      }

      return res.status(500).json({
        error: 'Google Ads API rejected the request: ' + (err.message || code),
        code: err.code || null,
      });
    }

    if (resourceNames.length === 0) {
      return res.status(200).json({
        success: true,
        customers: [],
        selected: { customerId: creds.customerId, loginCustomerId: creds.loginCustomerId },
        warning: 'No accessible Google Ads customers found for this Google account',
      });
    }

    // ── Step 2: Fetch details for each customer (parallel) ──────────────────
    // We try each customer directly (no login_customer_id). For standalone
    // customers and manager accounts this works. For client accounts under
    // an MCC, this MAY fail — we silently skip those rather than failing the
    // whole list (the user can still see+pick their accessible customers).
    const customers = await Promise.all(resourceNames.map(async (resourceName) => {
      const customerId = customerIdFromResourceName(resourceName);
      if (!customerId) return null;

      try {
        const customer = client.Customer({
          customer_id: customerId,
          refresh_token: creds.refreshToken,
        });

        const rows = await customer.query(`
          SELECT
            customer.id,
            customer.descriptive_name,
            customer.currency_code,
            customer.time_zone,
            customer.manager,
            customer.test_account
          FROM customer
        `);

        // Query returns an array — for the customer resource there should be exactly one row
        const c = rows[0]?.customer;
        if (!c) return { id: customerId, name: '(unable to fetch details)', currency: null, timezone: null, manager: false, testAccount: false };

        return {
          id: customerId,
          name: c.descriptive_name || `Customer ${customerId}`,
          currency: c.currency_code || null,
          timezone: c.time_zone || null,
          manager: Boolean(c.manager),
          testAccount: Boolean(c.test_account),
        };
      } catch (err) {
        // Skip individual customers that fail (e.g., client accounts under MCC
        // that need login_customer_id). User can still see the ones that work.
        console.warn(`[google-ads-accounts] details query failed for ${customerId}:`, err.message);
        return {
          id: customerId,
          name: `Customer ${customerId} (details unavailable)`,
          currency: null,
          timezone: null,
          manager: null,
          testAccount: null,
          detailsUnavailable: true,
        };
      }
    }));

    const validCustomers = customers.filter(Boolean);

    // Sort: manager accounts first (likely MCCs), then by name
    validCustomers.sort((a, b) => {
      if (a.manager && !b.manager) return -1;
      if (!a.manager && b.manager) return 1;
      return (a.name || '').localeCompare(b.name || '');
    });

    return res.status(200).json({
      success: true,
      customers: validCustomers,
      selected: {
        customerId: creds.customerId,
        loginCustomerId: creds.loginCustomerId,
      },
    });

  } catch (err) {
    console.error('[google-ads-accounts] error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
