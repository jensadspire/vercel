// /api/google-ads-publish.js
// Publishes Responsive Search Ads (RSAs) to Google Ads via the Google Ads API.
// All ads created as PAUSED — no spend until manually activated.
//
// PHASE 2 STATUS: Skeleton ready. Actual mutation calls are wired but the
// endpoint is guarded by GOOGLE_ADS_PUBLISH_ENABLED env var, defaulting to
// "false" until Basic developer token access is approved by Google. Until then,
// the endpoint returns 503 with a friendly message.
//
// Token resolution (mirrors meta-publish.js pattern):
//   1. If the request includes a valid Clerk session token AND the user has
//      connected their own Google Ads account, use their per-user credentials
//      (customer_id + encrypted refresh token in Upstash).
//   2. No env-var fallback for Google Ads (unlike Meta) — Google Ads requires
//      a real customer_id selection from a connected user.

import { createClerkClient } from '@clerk/backend';
import { GoogleAdsApi, enums } from 'google-ads-api';
import { getGoogleAdsCredentials } from './lib/google-ads-token-store.js';

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY,
});

// ── Feature flag ──────────────────────────────────────────────────────────────
// Default DISABLED. Flip GOOGLE_ADS_PUBLISH_ENABLED="true" in Vercel env once
// Basic developer token access is approved AND testing against test MCC succeeds.
const PUBLISH_ENABLED = process.env.GOOGLE_ADS_PUBLISH_ENABLED === 'true';

// ── Auth helper (mirrors other google-ads-*.js endpoints) ─────────────────────
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

// ── Request validation ────────────────────────────────────────────────────────
// Expected request body shape (sent from frontend "Publish to Google Ads" button):
//   {
//     // Required
//     headlines: ["Headline 1", "Headline 2", ...],   // 3-15 headlines, each ≤30 chars
//     descriptions: ["Description 1", ...],            // 2-4 descriptions, each ≤90 chars
//     finalUrl: "https://example.com/product/123",
//
//     // Optional creative fields
//     path1: "category",                               // up to 15 chars
//     path2: "subcategory",                            // up to 15 chars
//
//     // Campaign/ad-group selection — one of:
//     campaignId: "1234567890",                        // use existing campaign
//     adGroupId: "9876543210",                         // use existing ad group
//     // OR create new (Phase 2.1 — won't implement yet):
//     newCampaign: { name: "...", budgetMicros: 50000000, ... },
//   }

function validateRequestBody(body) {
  const errors = [];
  if (!body) errors.push('request body required');
  else {
    if (!Array.isArray(body.headlines) || body.headlines.length < 3) {
      errors.push('headlines: array of at least 3 strings required');
    } else {
      const tooLong = body.headlines.filter(h => typeof h !== 'string' || h.length > 30);
      if (tooLong.length) errors.push(`headlines: each must be ≤30 chars (${tooLong.length} too long)`);
    }
    if (!Array.isArray(body.descriptions) || body.descriptions.length < 2) {
      errors.push('descriptions: array of at least 2 strings required');
    } else {
      const tooLong = body.descriptions.filter(d => typeof d !== 'string' || d.length > 90);
      if (tooLong.length) errors.push(`descriptions: each must be ≤90 chars (${tooLong.length} too long)`);
    }
    if (!body.finalUrl || !/^https?:\/\//i.test(body.finalUrl)) {
      errors.push('finalUrl: valid http(s) URL required');
    }
    if (body.path1 && (typeof body.path1 !== 'string' || body.path1.length > 15)) {
      errors.push('path1: must be string ≤15 chars');
    }
    if (body.path2 && (typeof body.path2 !== 'string' || body.path2.length > 15)) {
      errors.push('path2: must be string ≤15 chars');
    }
    if (!body.adGroupId && !body.campaignId) {
      errors.push('adGroupId or campaignId required (existing ad group/campaign to publish into)');
    }
  }
  return errors;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    // ─── 1. Auth ───────────────────────────────────────────────────────────
    const userId = await authenticateUser(req);

    // ─── 2. Feature flag check ─────────────────────────────────────────────
    if (!PUBLISH_ENABLED) {
      return res.status(503).json({
        error: 'Google Ads publishing is not yet enabled',
        reason: 'Awaiting Google Ads API Basic developer token approval. Once approved, this endpoint will be activated by setting GOOGLE_ADS_PUBLISH_ENABLED=true in Vercel env.',
        phase: 'phase-2-pending',
      });
    }

    // ─── 3. Validate request body ──────────────────────────────────────────
    const validationErrors = validateRequestBody(req.body);
    if (validationErrors.length) {
      return res.status(400).json({ error: 'Validation failed', details: validationErrors });
    }

    // ─── 4. Retrieve user's Google Ads credentials + selection ─────────────
    const creds = await getGoogleAdsCredentials(userId);
    if (!creds?.refreshToken) {
      return res.status(400).json({ error: 'Google Ads account not connected', needsConnect: true });
    }
    if (!creds.customerId) {
      return res.status(400).json({ error: 'No Google Ads account selected', needsSelection: true });
    }

    // ─── 5. Initialize Google Ads API client ───────────────────────────────
    const client = new GoogleAdsApi({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    });

    const customer = client.Customer({
      customer_id: creds.customerId,
      refresh_token: creds.refreshToken,
      // login_customer_id is only needed when the selected customer is a
      // client account under an MCC (manager). If selection includes a
      // loginCustomerId, use it; otherwise omit (works for top-level accounts).
      ...(creds.loginCustomerId ? { login_customer_id: creds.loginCustomerId } : {}),
    });

    // ─── 6. Build the RSA ad resource ──────────────────────────────────────
    const { headlines, descriptions, finalUrl, path1, path2, adGroupId } = req.body;

    const responsiveSearchAd = {
      headlines: headlines.map(text => ({ text })),
      descriptions: descriptions.map(text => ({ text })),
      ...(path1 ? { path1 } : {}),
      ...(path2 ? { path2 } : {}),
    };

    const adGroupAd = {
      ad_group: `customers/${creds.customerId}/adGroups/${adGroupId}`,
      status: enums.AdGroupAdStatus.PAUSED,  // Always paused — user activates manually
      ad: {
        final_urls: [finalUrl],
        responsive_search_ad: responsiveSearchAd,
      },
    };

    // ─── 7. Submit to Google Ads ───────────────────────────────────────────
    // Uses the library's resource-typed mutate. Returns array of resource names
    // (e.g., "customers/1234567890/adGroupAds/9876543210~5555555555").
    let createdAdGroupAd;
    try {
      const result = await customer.adGroupAds.create([adGroupAd]);
      createdAdGroupAd = result.results?.[0];
      if (!createdAdGroupAd) throw new Error('Google returned no created ad reference');
    } catch (err) {
      console.error('[google-ads-publish] mutation failed:', err.message, err);
      // GoogleAdsFailure includes structured error info — surface the first one
      const firstError = err.errors?.[0];
      const friendlyMsg = firstError?.message || err.message || 'Google Ads API error';
      return res.status(500).json({
        error: 'Google Ads rejected the ad: ' + friendlyMsg,
        details: err.errors || null,
      });
    }

    return res.status(200).json({
      success: true,
      resourceName: createdAdGroupAd.resource_name,
      status: 'PAUSED',
      customerId: creds.customerId,
      adGroupId,
      message: 'Ad created as PAUSED. Activate it in your Google Ads account when ready.',
    });

  } catch (err) {
    console.error('[google-ads-publish] error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
