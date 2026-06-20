// /api/google-ads-publish-pmax.js
// Publishes a Performance Max ASSET GROUP into an EXISTING PMax campaign.
//
// Mirrors google-ads-publish.js (RSA) for auth/creds/client, but the PMax shape
// is different: there is no ad group. The asset group IS the publish target, and
// it is always created fresh, linked to a campaign the user already has.
//
// SAFETY:
//   • status PAUSED — never spends until manually activated in Google Ads.
//   • validateOnly  — when true, Google validates the ENTIRE assembly server-side
//                     and creates NOTHING (zero-risk dry run). Allowed even when the
//                     publish feature flag is off, so the flow can be tested safely.
//   • atomic        — one mutateResources call; all-or-nothing, so a failure never
//                     leaves orphan assets behind.
//   • FEATURE FLAG  — real (non-dry-run) publishing gated by GOOGLE_ADS_PUBLISH_ENABLED.
//
// SCOPE: existing-campaign-only. Creating a NEW PMax campaign (budget + bidding) is
// intentionally out of scope for now.
//
// Asset group assembly (one atomic mutateResources call, temp resource ids):
//   1. text assets  — business name, headlines, long headlines, descriptions
//   2. image assets — landscape (1.91:1), square (1:1), portrait (4:5, optional), logo (1:1)
//   3. asset group  — linked to the chosen campaign, final URL, paths, PAUSED
//   4. links        — asset_group_asset rows tying each asset to the group by field type

import { createClerkClient } from '@clerk/backend';
import { GoogleAdsApi, enums, ResourceNames } from 'google-ads-api';
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

function normalizeId(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^0-9]/g, '');
  return cleaned.length > 0 ? cleaned : null;
}

// Clean a text list: stringify, trim, drop empties.
function cleanTexts(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(t => String(t == null ? '' : t).trim()).filter(t => t.length > 0);
}

function validateRequestBody(body) {
  const errors = [];
  if (!body) { errors.push('request body required'); return errors; }

  if (!normalizeId(body.campaignId)) {
    errors.push('campaignId required (an existing Performance Max campaign to publish into)');
  }

  const businessName = String(body.businessName || '').trim();
  if (!businessName) errors.push('businessName required');
  else if (businessName.length > 25) errors.push('businessName: must be ≤25 chars');

  const headlines = cleanTexts(body.headlines);
  if (headlines.length < 3) errors.push(`headlines: at least 3 required (got ${headlines.length})`);
  if (headlines.length > 15) errors.push(`headlines: max 15 (got ${headlines.length})`);
  if (headlines.some(h => h.length > 30)) errors.push('headlines: each must be ≤30 chars');

  const longHeadlines = cleanTexts(body.longHeadlines);
  if (longHeadlines.length < 1) errors.push('longHeadlines: at least 1 required');
  if (longHeadlines.length > 5) errors.push('longHeadlines: max 5');
  if (longHeadlines.some(h => h.length > 90)) errors.push('longHeadlines: each must be ≤90 chars');

  const descriptions = cleanTexts(body.descriptions);
  if (descriptions.length < 1) errors.push('descriptions: at least 1 required');
  if (descriptions.length > 5) errors.push('descriptions: max 5');
  if (descriptions.some(d => d.length > 90)) errors.push('descriptions: each must be ≤90 chars');

  if (!body.finalUrl || !/^https?:\/\//i.test(body.finalUrl)) {
    errors.push('finalUrl: valid http(s) URL required');
  }
  if (body.path1 && (typeof body.path1 !== 'string' || body.path1.length > 15)) {
    errors.push('path1: must be string ≤15 chars');
  }
  if (body.path2 && (typeof body.path2 !== 'string' || body.path2.length > 15)) {
    errors.push('path2: must be string ≤15 chars');
  }

  const img = body.images || {};
  const land = Array.isArray(img.landscape) ? img.landscape.filter(Boolean) : [];
  const sq = Array.isArray(img.square) ? img.square.filter(Boolean) : [];
  if (land.length < 1) errors.push('images.landscape: at least 1 landscape (1.91:1) image required');
  if (sq.length < 1) errors.push('images.square: at least 1 square (1:1) image required');
  if (!body.logoUrl) errors.push('logoUrl required (square 1:1 logo)');

  return errors;
}

async function fetchImageBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Could not fetch image (HTTP ${r.status}): ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const userId = await authenticateUser(req);

    const validateOnly = req.body?.validateOnly === true;

    // Real publishing is gated; dry runs (validateOnly) are always allowed since
    // they create nothing — that's how we test the assembly before enabling writes.
    if (!validateOnly && !PUBLISH_ENABLED) {
      return res.status(503).json({
        error: 'Google Ads publishing is not yet enabled',
        reason: 'Set GOOGLE_ADS_PUBLISH_ENABLED=true in Vercel env to activate. Dry runs (validateOnly:true) work without it.',
        phase: 'pmax-publish-pending',
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

    const cid = creds.customerId;
    const campaignId = normalizeId(req.body.campaignId);
    const assetGroupName = String(req.body.assetGroupName || '').trim() || `Asset Group ${Date.now()}`;
    const businessName = String(req.body.businessName).trim();
    const headlines = cleanTexts(req.body.headlines).slice(0, 15);
    const longHeadlines = cleanTexts(req.body.longHeadlines).slice(0, 5);
    const descriptions = cleanTexts(req.body.descriptions).slice(0, 5);
    const { finalUrl, path1, path2, logoUrl } = req.body;
    const img = req.body.images || {};
    const landscape = (img.landscape || []).filter(Boolean).slice(0, 20);
    const square = (img.square || []).filter(Boolean).slice(0, 20);
    const portrait = (img.portrait || []).filter(Boolean).slice(0, 20);

    // ── Fetch all image bytes up front (asset group + logo) ──────────────────
    let landBufs, sqBufs, portBufs, logoBuf;
    try {
      [landBufs, sqBufs, portBufs, logoBuf] = await Promise.all([
        Promise.all(landscape.map(fetchImageBytes)),
        Promise.all(square.map(fetchImageBytes)),
        Promise.all(portrait.map(fetchImageBytes)),
        fetchImageBytes(logoUrl),
      ]);
    } catch (err) {
      return res.status(422).json({ error: 'Image fetch failed: ' + (err.message || String(err)) });
    }

    // ── Build the atomic operation list (temp ids, created-before-referenced) ─
    const ops = [];
    const links = [];
    let t = -1;
    const nextAsset = () => ResourceNames.asset(cid, t--);
    const agRN = ResourceNames.assetGroup(cid, -100000);

    const addText = (text, fieldType) => {
      const rn = nextAsset();
      ops.push({ entity: 'asset', operation: 'create',
        resource: { resource_name: rn, type: enums.AssetType.TEXT, text_asset: { text } } });
      links.push({ entity: 'asset_group_asset', operation: 'create',
        resource: { asset_group: agRN, asset: rn, field_type: fieldType } });
    };
    // Image assets REQUIRE a unique name (Google: NAME_REQUIRED_FOR_ASSET_TYPE);
    // text assets do not. Timestamp + sequence keeps names unique across requests;
    // Google dedupes images by content, so re-uploading identical bytes resolves to
    // the existing asset regardless of the name supplied here.
    const imgStamp = Date.now();
    let imgSeq = 0;
    const addImage = (data, fieldType, label) => {
      const rn = nextAsset();
      const name = `${businessName || 'PMax'} ${label} ${imgStamp}${imgSeq++}`.slice(0, 120);
      ops.push({ entity: 'asset', operation: 'create',
        resource: { resource_name: rn, type: enums.AssetType.IMAGE, name, image_asset: { data } } });
      links.push({ entity: 'asset_group_asset', operation: 'create',
        resource: { asset_group: agRN, asset: rn, field_type: fieldType } });
    };

    // 1. text assets
    addText(businessName, enums.AssetFieldType.BUSINESS_NAME);
    headlines.forEach(h => addText(h, enums.AssetFieldType.HEADLINE));
    longHeadlines.forEach(h => addText(h, enums.AssetFieldType.LONG_HEADLINE));
    descriptions.forEach(d => addText(d, enums.AssetFieldType.DESCRIPTION));
    // 2. image assets
    landBufs.forEach((b, i) => addImage(b, enums.AssetFieldType.MARKETING_IMAGE, `Landscape ${i + 1}`));
    sqBufs.forEach((b, i) => addImage(b, enums.AssetFieldType.SQUARE_MARKETING_IMAGE, `Square ${i + 1}`));
    portBufs.forEach((b, i) => addImage(b, enums.AssetFieldType.PORTRAIT_MARKETING_IMAGE, `Portrait ${i + 1}`));
    addImage(logoBuf, enums.AssetFieldType.LOGO, 'Logo');
    // 3. asset group (after its assets, before the links that reference it)
    ops.push({ entity: 'asset_group', operation: 'create', resource: {
      resource_name: agRN,
      campaign: `customers/${cid}/campaigns/${campaignId}`,
      name: assetGroupName,
      final_urls: [finalUrl],
      ...(path1 ? { path1 } : {}),
      ...(path2 ? { path2 } : {}),
      status: enums.AssetGroupStatus.PAUSED,
    } });
    // 4. links
    ops.push(...links);

    // ── Mutate (atomic). validateOnly creates nothing. ───────────────────────
    let result;
    try {
      result = await customer.mutateResources(ops, { validate_only: validateOnly, partial_failure: false });
    } catch (err) {
      console.error('[google-ads-publish-pmax] mutation failed:', err.message);
      const firstError = err.errors?.[0];
      const friendlyMsg = firstError?.message || err.message || 'Google Ads API error';
      return res.status(500).json({
        error: 'Google Ads rejected the asset group: ' + friendlyMsg,
        details: err.errors || null,
        validateOnly,
      });
    }

    // Asset group resource name lands in the results for a real create; empty for dry runs.
    const created = (result?.mutate_operation_responses || [])
      .map(r => r?.asset_group_result?.resource_name)
      .filter(Boolean);

    return res.status(200).json({
      success: true,
      validateOnly,
      status: validateOnly ? 'VALIDATED (nothing created)' : 'PAUSED',
      customerId: cid,
      campaignId,
      assetGroupName,
      assetGroupResourceName: created[0] || null,
      counts: {
        headlines: headlines.length,
        longHeadlines: longHeadlines.length,
        descriptions: descriptions.length,
        landscape: landBufs.length,
        square: sqBufs.length,
        portrait: portBufs.length,
        logo: 1,
      },
      message: validateOnly
        ? 'Dry run passed — the asset group assembles and validates. Nothing was created.'
        : 'Asset group created as PAUSED. Review and activate it in Google Ads when ready.',
    });

  } catch (err) {
    console.error('[google-ads-publish-pmax] error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
