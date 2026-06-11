// /api/google-ads-mcc-clients.js
// Returns the client accounts under a specific MCC (manager account).
// Used by the two-step picker: after a user selects an MCC, this endpoint
// fetches the accounts beneath it so the user can pick the one to publish to.
//
// Query parameter: ?mccId=1234567890 (the MCC customer ID, no dashes)
//
// Google Ads API specifics:
//   - This uses a customer_client query, which must be run against the MCC
//     itself (not against an arbitrary user-accessible customer)
//   - login_customer_id is REQUIRED for this call to work — without it,
//     Google rejects the query as the user might be a non-manager
//   - We query level = 1 only (direct children), not the full descendant tree

import { createClerkClient } from '@clerk/backend';
import { GoogleAdsApi } from 'google-ads-api';
import { getGoogleAdsCredentials } from './lib/google-ads-token-store.js';

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

function normalizeCustomerId(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^0-9]/g, '');
  return cleaned.length === 10 ? cleaned : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const userId = await authenticateUser(req);

    // ── Validate mccId query param ──────────────────────────────────────────
    const rawMccId = req.query?.mccId;
    const mccId = normalizeCustomerId(rawMccId);
    if (!mccId) {
      return res.status(400).json({
        error: 'mccId query parameter required (10-digit MCC customer ID)',
      });
    }

    // ── Retrieve credentials ────────────────────────────────────────────────
    const creds = await getGoogleAdsCredentials(userId);
    if (!creds?.refreshToken) {
      return res.status(400).json({ error: 'Google Ads account not connected', needsConnect: true });
    }

    // ── Init client ─────────────────────────────────────────────────────────
    const client = new GoogleAdsApi({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    });

    // ── Query the MCC for its direct children ───────────────────────────────
    // Crucially: customer_id AND login_customer_id are both the MCC's ID
    // (querying the MCC about itself + its children).
    const customer = client.Customer({
      customer_id: mccId,
      login_customer_id: mccId,
      refresh_token: creds.refreshToken,
    });

    let rows;
    try {
      rows = await customer.query(`
        SELECT
          customer_client.client_customer,
          customer_client.id,
          customer_client.descriptive_name,
          customer_client.currency_code,
          customer_client.time_zone,
          customer_client.manager,
          customer_client.test_account,
          customer_client.status,
          customer_client.level
        FROM customer_client
        WHERE customer_client.level = 1
      `);
    } catch (err) {
      console.error(`[google-ads-mcc-clients] query failed for MCC ${mccId}:`, err.message);
      if (String(err.message || '').toLowerCase().includes('refresh') ||
          String(err.message || '').toLowerCase().includes('invalid_grant')) {
        return res.status(401).json({
          error: 'Google Ads connection expired. Please reconnect.',
          needsReconnect: true,
        });
      }
      return res.status(500).json({
        error: 'Google Ads API rejected the MCC client query: ' + (err.message || 'unknown'),
        code: err.code || null,
      });
    }

    // ── Normalize the response ──────────────────────────────────────────────
    // customer_client.client_customer is a resource_name like "customers/1234567890"
    // We extract the trailing ID for consistency with the /accounts endpoint.
    const clients = (rows || []).map(row => {
      const cc = row.customer_client || {};
      const resourceMatch = String(cc.client_customer || '').match(/customers\/(\d+)/);
      const childId = resourceMatch ? resourceMatch[1] : (cc.id ? String(cc.id) : null);
      if (!childId) return null;

      return {
        id: childId,
        name: cc.descriptive_name || `Customer ${childId}`,
        currency: cc.currency_code || null,
        timezone: cc.time_zone || null,
        manager: Boolean(cc.manager),
        testAccount: Boolean(cc.test_account),
        status: cc.status || null,  // ENABLED / CANCELED / SUSPENDED / etc.
      };
    }).filter(Boolean);

    // Filter out cancelled/suspended accounts — user can't publish to those
    const enabledClients = clients.filter(c => !c.status || c.status === 'ENABLED' || c.status === 2);
    // (Google Ads status enum: 2 = ENABLED. We accept the string or the numeric.)

    // Sort: managers (sub-MCCs) first, then alphabetical
    enabledClients.sort((a, b) => {
      if (a.manager && !b.manager) return -1;
      if (!a.manager && b.manager) return 1;
      return (a.name || '').localeCompare(b.name || '');
    });

    return res.status(200).json({
      success: true,
      mccId,
      clients: enabledClients,
      totalIncludingDisabled: clients.length,
    });

  } catch (err) {
    console.error('[google-ads-mcc-clients] error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
