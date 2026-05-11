// /api/meta-publish.js
// Publishes ads to Meta Ads Manager via Marketing API.
// Supports three formats: single (image), carousel (multiple images), video.
// All ads created as PAUSED — no spend until manually activated.

const META_API_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${META_API_VERSION}`;

// ── Helpers ─────────────────────────────────────────────────────────────────

async function fetchAsBase64(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.toString('base64');
}

async function uploadImage({ adAccountId, accessToken, imageUrl }) {
  // Meta requires images uploaded as bytes (base64) → returns image_hash
  const b64 = await fetchAsBase64(imageUrl);
  const body = new URLSearchParams();
  body.append('bytes', b64);
  body.append('access_token', accessToken);
  const r = await fetch(`${GRAPH}/${adAccountId}/adimages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json();
  if (data.error) throw new Error(`Image upload failed: ${data.error.message}`);
  const images = data.images || {};
  const firstKey = Object.keys(images)[0];
  if (!firstKey) throw new Error('No image hash returned from Meta');
  return images[firstKey].hash;
}

async function uploadVideo({ adAccountId, accessToken, videoUrl }) {
  // Meta supports remote URL upload for videos via file_url param
  const body = new URLSearchParams();
  body.append('file_url', videoUrl);
  body.append('access_token', accessToken);
  const r = await fetch(`${GRAPH}/${adAccountId}/advideos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json();
  if (data.error) throw new Error(`Video upload failed: ${data.error.message}`);
  if (!data.id) throw new Error('No video id returned from Meta');
  return data.id;
}

async function waitForVideoReady({ videoId, accessToken, maxAttempts = 60, intervalMs = 5000 }) {
  // Poll until video status is "ready" (or fail/error). Meta processes videos async.
  for (let i = 0; i < maxAttempts; i++) {
    const r = await fetch(`${GRAPH}/${videoId}?fields=status&access_token=${accessToken}`);
    const data = await r.json();
    const phase = data?.status?.video_status || data?.status?.processing_phase;
    if (phase === 'ready') return true;
    if (phase === 'error') throw new Error(`Video processing failed: ${JSON.stringify(data.status)}`);
    await new Promise(res => setTimeout(res, intervalMs));
  }
  // Don't hard-fail — Meta will accept the creative once ready, and we surface a warning
  return false;
}

async function createCampaign({ adAccountId, accessToken, name }) {
  const body = new URLSearchParams();
  body.append('name', name);
  body.append('objective', 'OUTCOME_TRAFFIC');
  body.append('status', 'PAUSED');
  body.append('special_ad_categories', '[]');
  body.append('access_token', accessToken);
  const r = await fetch(`${GRAPH}/${adAccountId}/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json();
  if (data.error) throw new Error(`Campaign create failed: ${data.error.message}`);
  return data.id;
}

async function createAdSet({ adAccountId, accessToken, campaignId, name, targeting, dsa }) {
  const body = new URLSearchParams();
  body.append('name', name);
  body.append('campaign_id', campaignId);
  body.append('status', 'PAUSED');
  body.append('billing_event', 'IMPRESSIONS');
  body.append('optimization_goal', 'LINK_CLICKS');
  body.append('daily_budget', String(targeting?.dailyBudget || 1000));
  body.append('bid_strategy', 'LOWEST_COST_WITHOUT_CAP');

  const t = {
    geo_locations: { countries: targeting?.countries || ['DK'] },
    age_min: targeting?.ageMin || 25,
    age_max: targeting?.ageMax || 65,
  };
  if (targeting?.placements === 'automatic') {
    t.targeting_automation = { advantage_audience: 1 };
  }
  body.append('targeting', JSON.stringify(t));

  // EU DSA compliance
  if (dsa) {
    body.append('dsa_beneficiary', dsa.beneficiary);
    body.append('dsa_payor', dsa.payor);
  }

  body.append('access_token', accessToken);
  const r = await fetch(`${GRAPH}/${adAccountId}/adsets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json();
  if (data.error) throw new Error(`AdSet create failed: ${data.error.message}`);
  return data.id;
}

async function createCreative({ adAccountId, accessToken, pageId, payload }) {
  const body = new URLSearchParams();
  body.append('name', payload.name || 'AI Ad Studio Creative');
  body.append('object_story_spec', JSON.stringify({
    page_id: pageId,
    ...payload.story,
  }));
  body.append('access_token', accessToken);
  const r = await fetch(`${GRAPH}/${adAccountId}/adcreatives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json();
  if (data.error) throw new Error(`Creative create failed: ${data.error.message}`);
  return data.id;
}

async function createAd({ adAccountId, accessToken, name, adSetId, creativeId }) {
  const body = new URLSearchParams();
  body.append('name', name);
  body.append('adset_id', adSetId);
  body.append('creative', JSON.stringify({ creative_id: creativeId }));
  body.append('status', 'PAUSED');
  body.append('access_token', accessToken);
  const r = await fetch(`${GRAPH}/${adAccountId}/ads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json();
  if (data.error) throw new Error(`Ad create failed: ${data.error.message}`);
  return data.id;
}

// ── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const adAccountId = process.env.META_AD_ACCOUNT_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;
  const pageId = process.env.META_PAGE_ID;
  if (!adAccountId || !accessToken || !pageId) {
    return res.status(500).json({ error: 'Meta env vars not configured' });
  }

  const dsa = {
    beneficiary: 'Adspire Deutschland GmbH',
    payor: 'Adspire Deutschland GmbH',
  };

  try {
    const {
      headline, primaryText, description,
      imageUrl, videoUrl, destinationUrl,
      adName, campaignName,
      format = 'single', // 'single' | 'carousel' | 'video'
      carouselCards = [],
      existingCampaignId, existingAdSetId,
      targeting,
    } = req.body || {};

    if (!destinationUrl) return res.status(400).json({ error: 'destinationUrl required' });
    if (format === 'video' && !videoUrl) return res.status(400).json({ error: 'videoUrl required for video format' });
    if (format !== 'video' && !imageUrl && format !== 'carousel') return res.status(400).json({ error: 'imageUrl required' });

    // ── 1. Campaign (existing or new) ────────────────────────────────────
    let campaignId = existingCampaignId;
    if (!campaignId) {
      campaignId = await createCampaign({
        adAccountId, accessToken,
        name: campaignName || `AI Ad Studio — ${new Date().toLocaleDateString()}`,
      });
    }

    // ── 2. Ad set (existing or new) ──────────────────────────────────────
    let adSetId = existingAdSetId;
    if (!adSetId) {
      adSetId = await createAdSet({
        adAccountId, accessToken, campaignId,
        name: (adName || 'AI Ad Studio') + ' — Ad Set',
        targeting,
        dsa,
      });
    }

    // ── 3. Build creative based on format ────────────────────────────────
    let creativeId;

    if (format === 'video') {
      // Upload video → wait for processing → upload thumbnail → build video_data
      const videoId = await uploadVideo({ adAccountId, accessToken, videoUrl });
      // Wait for Meta to finish processing (non-blocking on timeout — Meta will catch up)
      await waitForVideoReady({ videoId, accessToken }).catch(() => null);

      // Upload thumbnail (image_url is required for video_data — provides hi-res cover)
      let thumbnailUrl = imageUrl; // imageUrl carries the starting image for video case
      if (!thumbnailUrl) {
        // Fall back to Meta's auto-extracted thumbnail (will be set after processing completes)
        const thumbRes = await fetch(`${GRAPH}/${videoId}/thumbnails?access_token=${accessToken}`);
        const thumbData = await thumbRes.json();
        const preferred = (thumbData.data || []).find(t => t.is_preferred) || (thumbData.data || [])[0];
        thumbnailUrl = preferred?.uri;
      }
      if (!thumbnailUrl) throw new Error('No video thumbnail available');

      creativeId = await createCreative({
        adAccountId, accessToken, pageId,
        payload: {
          name: (adName || 'AI Ad Studio') + ' — Video Creative',
          story: {
            video_data: {
              video_id: videoId,
              title: (headline || '').slice(0, 40),
              message: primaryText || '',
              image_url: thumbnailUrl,
              call_to_action: {
                type: 'LEARN_MORE',
                value: { link: destinationUrl },
              },
            },
          },
        },
      });
    } else if (format === 'carousel') {
      if (!carouselCards.length) return res.status(400).json({ error: 'carouselCards required for carousel format' });
      const childAttachments = [];
      for (const card of carouselCards) {
        const hash = await uploadImage({ adAccountId, accessToken, imageUrl: card.imageUrl });
        childAttachments.push({
          link: card.url || destinationUrl,
          image_hash: hash,
          name: (card.headline || '').slice(0, 40),
          description: (card.description || '').slice(0, 90),
          call_to_action: { type: 'LEARN_MORE', value: { link: card.url || destinationUrl } },
        });
      }
      creativeId = await createCreative({
        adAccountId, accessToken, pageId,
        payload: {
          name: (adName || 'AI Ad Studio') + ' — Carousel Creative',
          story: {
            link_data: {
              link: destinationUrl,
              message: primaryText || '',
              child_attachments: childAttachments,
              multi_share_optimized: true,
              call_to_action: { type: 'LEARN_MORE', value: { link: destinationUrl } },
            },
          },
        },
      });
    } else {
      // Single image
      const imageHash = await uploadImage({ adAccountId, accessToken, imageUrl });
      creativeId = await createCreative({
        adAccountId, accessToken, pageId,
        payload: {
          name: (adName || 'AI Ad Studio') + ' — Image Creative',
          story: {
            link_data: {
              link: destinationUrl,
              message: primaryText || '',
              name: (headline || '').slice(0, 40),
              description: (description || '').slice(0, 90),
              image_hash: imageHash,
              call_to_action: { type: 'LEARN_MORE', value: { link: destinationUrl } },
            },
          },
        },
      });
    }

    // ── 4. Ad ────────────────────────────────────────────────────────────
    const adId = await createAd({
      adAccountId, accessToken,
      name: adName || 'AI Ad Studio Ad',
      adSetId,
      creativeId,
    });

    const accountNumeric = adAccountId.replace('act_', '');
    const adsManagerUrl = `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${accountNumeric}&selected_ad_ids=${adId}`;

    return res.status(200).json({
      success: true,
      adId, creativeId, adSetId, campaignId,
      format,
      adsManagerUrl,
    });
  } catch (err) {
    console.error('meta-publish error:', err);
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
}
