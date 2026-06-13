// /api/google-ads-campaigns.js
// Returns the campaigns under the user's currently-selected Google Ads customer.
// Used by the publish modal: after the user clicks "Publish to Google Ads",
// they pick which campaign their RSAs should be created under.
//
// Filtering: We return ALL non-removed campaigns regardless of channel type.
// Phase 2.5a doesn't filter by Search vs PMax (a label is shown so the user
// can choose appropriately). Filtering can be added in 2.5b if needed.

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

// Map Google Ads channel-type enum values to friendly labels for the UI.
// See: https://developers.google.com/google-ads/api/reference/rpc/latest/AdvertisingChannelTypeEnum.AdvertisingChannelType
const CHANNEL_TYPE_LABELS = {
  2: 'Search',
  3: 'Display',
  4: 'Shopping',
  6: 'Video',
  7: 'Multi-channel',
  8: 'Local',
  9: 'Smart',
  10: 'Performance Max',  // PMax
  11: 'Local Services',
  13: 'Travel',
  14: 'Demand Gen',
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const userId = await authenticateUser(req);

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

    // ── Query campaigns (exclude removed/deleted) ───────────────────────────
    let rows;
    try {
      rows = await customer.query(`
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          campaign.advertising_channel_type,
          campaign.advertising_channel_sub_type
        FROM campaign
        WHERE campaign.status != 'REMOVED'
        ORDER BY campaign.name
      `);
    } catch (err) {
      console.error('[google-ads-campaigns] query failed:', err.message);
      if (String(err.message || '').toLowerCase().includes('refresh') ||
          String(err.message || '').toLowerCase().includes('invalid_grant')) {
        return res.status(401).json({
          error: 'Google Ads connection expired. Please reconnect.',
          needsReconnect: true,
        });
      }
      return res.status(500).json({
        error: 'Google Ads API rejected the campaigns query: ' + (err.message || 'unknown'),
        code: err.code || null,
      });
    }

    // ── Normalize ───────────────────────────────────────────────────────────
    const campaigns = (rows || []).map(row => {
      const c = row.campaign || {};
      const id = c.id ? String(c.id) : null;
      if (!id) return null;
      const channelType = typeof c.advertising_channel_type === 'number'
        ? c.advertising_channel_type
        : null;
      return {
        id,
        name: c.name || `Campaign ${id}`,
        status: c.status || null,  // ENABLED / PAUSED / etc.
        channelType: channelType,
        channelTypeLabel: channelType != null ? (CHANNEL_TYPE_LABELS[channelType] || 'Unknown') : 'Unknown',
      };
    }).filter(Boolean);

    return res.status(200).json({
      success: true,
      customerId: creds.customerId,
      campaigns,
    });

  } catch (err) {
    console.error('[google-ads-campaigns] error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
