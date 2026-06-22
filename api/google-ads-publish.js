// /api/google-ads-publish.js
// Publishes Responsive Search Ads (RSAs) to Google Ads via the Google Ads API.
// All ads created as PAUSED — no spend until manually activated.
//
// FEATURE FLAG: Gated by GOOGLE_ADS_PUBLISH_ENABLED env var, defaulting to
// "false". Flip to "true" in Vercel env to activate publishing.
//
// Multi-ad publishing: Frontend calls this endpoint ONCE PER AD. To publish
// 3 variations, frontend makes 3 sequential POST calls. This gives clean
// partial-success semantics (one ad fails, others still succeed) and live
// progress feedback in the UI.

import { createClerkClient } from '@clerk/backend';
import { GoogleAdsApi, enums } from 'google-ads-api';
import { getGoogleAdsCredentials } from './lib/google-ads-token-store.js';

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY,
});

const PUBLISH_ENABLED = process.env.GOOGLE_ADS_PUBLISH_ENABLED === 'true';

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

// Accepts either a plain string ("text") or an object ({ text, pin })
function normalizeAsset(raw) {
  if (typeof raw === 'string') return { text: raw, pin: 0 };
  if (raw && typeof raw === 'object') {
    const text = String(raw.text || '');
    const pinRaw = raw.pin;
    let pin = 0;
    if (typeof pinRaw === 'number') pin = pinRaw;
    else if (typeof pinRaw === 'string' && pinRaw !== '') pin = parseInt(pinRaw, 10) || 0;
    return { text, pin };
  }
  return { text: '', pin: 0 };
}

function validateRequestBody(body) {
  const errors = [];
  if (!body) { errors.push('request body required'); return errors; }

  if (!Array.isArray(body.headlines) || body.headlines.length < 3) {
    errors.push('headlines: array of at least 3 items required');
  } else {
    const normalized = body.headlines.map(normalizeAsset).filter(a => a.text.length > 0);
    if (normalized.length < 3) errors.push(`headlines: at least 3 non-empty headlines required (got ${normalized.length})`);
    if (normalized.length > 15) errors.push(`headlines: max 15 (got ${normalized.length})`);
    const tooLong = normalized.filter(h => h.text.length > 30);
    if (tooLong.length) errors.push(`headlines: each text must be ≤30 chars (${tooLong.length} too long)`);
    const badPin = normalized.filter(h => h.pin && (h.pin < 1 || h.pin > 3));
    if (badPin.length) errors.push(`headlines: pin must be 1, 2, or 3 (or 0/empty for unpinned)`);
  }

  if (!Array.isArray(body.descriptions) || body.descriptions.length < 2) {
    errors.push('descriptions: array of at least 2 items required');
  } else {
    const normalized = body.descriptions.map(normalizeAsset).filter(a => a.text.length > 0);
    if (normalized.length < 2) errors.push(`descriptions: at least 2 non-empty descriptions required (got ${normalized.length})`);
    if (normalized.length > 4) errors.push(`descriptions: max 4 (got ${normalized.length})`);
    const tooLong = normalized.filter(d => d.text.length > 90);
    if (tooLong.length) errors.push(`descriptions: each text must be ≤90 chars (${tooLong.length} too long)`);
    const badPin = normalized.filter(d => d.pin && (d.pin < 1 || d.pin > 2));
    if (badPin.length) errors.push(`descriptions: pin must be 1 or 2 (or 0/empty for unpinned)`);
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

  // Target: either an existing ad group (adGroupId) OR a new one (newAdGroupName).
  if (!body.adGroupId && !(body.newAdGroupName && String(body.newAdGroupName).trim())) {
    errors.push('adGroupId (existing) or newAdGroupName (to create) required');
  }
  if (body.newAdGroupName && String(body.newAdGroupName).trim().length > 255) {
    errors.push('newAdGroupName: must be ≤255 chars');
  }
  if (body.cpcBidMicros != null) {
    const n = Number(body.cpcBidMicros);
    if (!Number.isFinite(n) || n < 0) errors.push('cpcBidMicros: must be a non-negative number');
  }

  return errors;
}

function pinToHeadlineEnum(pin) {
  if (pin === 1) return enums.ServedAssetFieldType.HEADLINE_1;
  if (pin === 2) return enums.ServedAssetFieldType.HEADLINE_2;
  if (pin === 3) return enums.ServedAssetFieldType.HEADLINE_3;
  return undefined;
}

function pinToDescriptionEnum(pin) {
  if (pin === 1) return enums.ServedAssetFieldType.DESCRIPTION_1;
  if (pin === 2) return enums.ServedAssetFieldType.DESCRIPTION_2;
  return undefined;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const userId = await authenticateUser(req);

    if (!PUBLISH_ENABLED) {
      return res.status(503).json({
        error: 'Google Ads publishing is not yet enabled',
        reason: 'Set GOOGLE_ADS_PUBLISH_ENABLED=true in Vercel env to activate.',
        phase: 'phase-2-pending',
      });
    }

    const validationErrors = validateRequestBody(req.body);
    if (validationErrors.length) {
      return res.status(400).json({ error: 'Validation failed', details: validationErrors });
    }

    const creds = await getGoogleAdsCredentials(userId);
    if (!creds?.refreshToken) {
      return res.status(400).json({ error: 'Google Ads account not connected', needsConnect: true });
    }
    if (!creds.customerId) {
      return res.status(400).json({ error: 'No Google Ads account selected', needsSelection: true });
    }

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

    const { headlines: rawHeadlines, descriptions: rawDescriptions, finalUrl, path1, path2, adGroupId, newAdGroupName, cpcBidMicros, campaignId } = req.body;

    const normalizedHeadlines = rawHeadlines.map(normalizeAsset).filter(a => a.text.length > 0);
    const normalizedDescriptions = rawDescriptions.map(normalizeAsset).filter(a => a.text.length > 0);

    const responsiveSearchAd = {
      headlines: normalizedHeadlines.map(h => {
        const asset = { text: h.text };
        const pinned = pinToHeadlineEnum(h.pin);
        if (pinned !== undefined) asset.pinned_field = pinned;
        return asset;
      }),
      descriptions: normalizedDescriptions.map(d => {
        const asset = { text: d.text };
        const pinned = pinToDescriptionEnum(d.pin);
        if (pinned !== undefined) asset.pinned_field = pinned;
        return asset;
      }),
      ...(path1 ? { path1 } : {}),
      ...(path2 ? { path2 } : {}),
    };

    const wantNewAdGroup = !!(newAdGroupName && String(newAdGroupName).trim());

    // ── Path A: create a NEW ad group + the ad atomically ────────────────────
    // One mutateResources call: ad_group (temp resource name, PAUSED) then the
    // ad_group_ad referencing it. All-or-nothing — if the ad fails validation,
    // the ad group is not created either (no orphaned empty ad group).
    if (wantNewAdGroup) {
      if (!campaignId) {
        return res.status(400).json({ error: 'campaignId required when creating a new ad group' });
      }
      const cid = creds.customerId;
      const tempAdGroupRN = `customers/${cid}/adGroups/-1`;
      const adGroupResource = {
        resource_name: tempAdGroupRN,
        name: String(newAdGroupName).trim(),
        campaign: `customers/${cid}/campaigns/${campaignId}`,
        status: enums.AdGroupStatus.PAUSED,
        type: enums.AdGroupType.SEARCH_STANDARD,
      };
      // Only set a manual CPC bid when one was provided (campaign is MANUAL_CPC).
      // Automated-bidding campaigns manage the bid; omitting it lets the ad group inherit.
      const bid = cpcBidMicros != null ? Math.round(Number(cpcBidMicros)) : null;
      if (bid != null && bid >= 0) adGroupResource.cpc_bid_micros = bid;

      const operations = [
        { entity: 'ad_group', operation: 'create', resource: adGroupResource },
        {
          entity: 'ad_group_ad', operation: 'create',
          resource: {
            ad_group: tempAdGroupRN,
            status: enums.AdGroupAdStatus.PAUSED,
            ad: { final_urls: [finalUrl], responsive_search_ad: responsiveSearchAd },
          },
        },
      ];

      let result;
      try {
        result = await customer.mutateResources(operations);
      } catch (err) {
        console.error('[google-ads-publish] new-ad-group mutation failed:', err.message);
        const firstError = err.errors?.[0];
        const friendlyMsg = firstError?.message || err.message || 'Google Ads API error';
        return res.status(500).json({
          error: 'Google Ads rejected the new ad group / ad: ' + friendlyMsg,
          details: err.errors || null,
        });
      }

      const responses = result?.mutate_operation_responses || [];
      const newAdGroupRN = responses[0]?.ad_group_result?.resource_name || null;
      const newAdRN = responses[1]?.ad_group_ad_result?.resource_name || null;
      const createdAdGroupId = newAdGroupRN ? newAdGroupRN.split('/').pop() : null;

      return res.status(200).json({
        success: true,
        resourceName: newAdRN,
        status: 'PAUSED',
        customerId: cid,
        campaignId,
        adGroupId: createdAdGroupId,
        adGroupResourceName: newAdGroupRN,
        createdAdGroup: { id: createdAdGroupId, name: String(newAdGroupName).trim() },
        message: 'New ad group + ad created as PAUSED. Activate them in Google Ads when ready.',
      });
    }

    // ── Path B: publish into an EXISTING ad group (original behavior) ─────────
    const adGroupAd = {
      ad_group: `customers/${creds.customerId}/adGroups/${adGroupId}`,
      status: enums.AdGroupAdStatus.PAUSED,
      ad: {
        final_urls: [finalUrl],
        responsive_search_ad: responsiveSearchAd,
      },
    };

    let createdAdGroupAd;
    try {
      const result = await customer.adGroupAds.create([adGroupAd]);
      createdAdGroupAd = result.results?.[0];
      if (!createdAdGroupAd) throw new Error('Google returned no created ad reference');
    } catch (err) {
      console.error('[google-ads-publish] mutation failed:', err.message);
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
      message: 'Ad created as PAUSED. Activate it in Google Ads when ready.',
    });

  } catch (err) {
    console.error('[google-ads-publish] error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
