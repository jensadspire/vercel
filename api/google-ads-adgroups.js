// /api/google-ads-adgroups.js
// Returns the ad groups under a specific campaign. Used by the publish modal:
// after the user picks a campaign, this endpoint fetches its ad groups so the
// user can pick which one to publish RSAs into.
//
// Query parameter: ?campaignId=1234567890

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

function normalizeId(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^0-9]/g, '');
  return cleaned.length > 0 ? cleaned : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const userId = await authenticateUser(req);

    // ── Validate campaignId query param ─────────────────────────────────────
    const campaignId = normalizeId(req.query?.campaignId);
    if (!campaignId) {
      return res.status(400).json({ error: 'campaignId query parameter required' });
    }

    // ── Retrieve credentials + selection ────────────────────────────────────
    const creds = await getGoogleAdsCredentials(userId);
    if (!creds?.refreshToken) {
      return res.status(400).json({ error: 'Google Ads account not connected', needsConnect: true });
    }
    if (!creds.customerId) {
      return res.status(400).json({ error: 'No Google Ads account selected. Pick one first.', needsSelection: true });
    }

    // ── Init client ─────────────────────────────────────────────────────────
    const client = new GoogleAdsApi({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    });

    const customer = client.Customer({
      customer_id: creds.customerId,
      refresh_token: creds.refreshToken,
      ...(creds.loginCustomerId ? { login_customer_id: creds.loginCustomerId } : {}),
    });

    // ── Query ad groups for this campaign ───────────────────────────────────
    let rows;
    try {
      rows = await customer.query(`
        SELECT
          ad_group.id,
          ad_group.name,
          ad_group.status,
          ad_group.type,
          ad_group.campaign
        FROM ad_group
        WHERE ad_group.campaign = 'customers/${creds.customerId}/campaigns/${campaignId}'
          AND ad_group.status != 'REMOVED'
        ORDER BY ad_group.name
      `);
    } catch (err) {
      console.error('[google-ads-adgroups] query failed:', err.message);
      if (String(err.message || '').toLowerCase().includes('refresh') ||
          String(err.message || '').toLowerCase().includes('invalid_grant')) {
        return res.status(401).json({
          error: 'Google Ads connection expired. Please reconnect.',
          needsReconnect: true,
        });
      }
      return res.status(500).json({
        error: 'Google Ads API rejected the ad groups query: ' + (err.message || 'unknown'),
        code: err.code || null,
      });
    }

    // ── Normalize ───────────────────────────────────────────────────────────
    const adGroups = (rows || []).map(row => {
      const ag = row.ad_group || {};
      const id = ag.id ? String(ag.id) : null;
      if (!id) return null;
      return {
        id,
        name: ag.name || `Ad Group ${id}`,
        status: ag.status || null,
        type: ag.type || null,
        campaignId,
      };
    }).filter(Boolean);

    return res.status(200).json({
      success: true,
      customerId: creds.customerId,
      campaignId,
      adGroups,
    });

  } catch (err) {
    console.error('[google-ads-adgroups] error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
