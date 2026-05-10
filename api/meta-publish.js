/**
 * /api/meta-publish — 1-click Meta ad creation via Marketing API
 * Creates: Campaign → Ad Set → Ad Creative → Ad
 * 
 * POST {
 *   headline, primaryText, description,
 *   imageUrl, destinationUrl,
 *   adName, campaignName,
 *   format: 'single' | 'carousel'
 *   carouselCards: [{ imageUrl, headline, description, url }]
 * }
 */

const FB_API = 'https://graph.facebook.com/v19.0';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.META_ACCESS_TOKEN;
  const adAccountId = process.env.META_AD_ACCOUNT_ID; // act_XXXXXXXXX
  const appId = process.env.META_APP_ID;

  if (!token || !adAccountId) {
    return res.status(500).json({ error: 'Meta credentials not configured' });
  }

  const {
    headline,
    primaryText,
    description,
    imageUrl,
    destinationUrl,
    adName = 'AI Ad Studio Ad',
    campaignName = 'AI Ad Studio Campaign',
    format = 'single',
    carouselCards = [],
    existingCampaignId = null,
    existingAdSetId = null,
  } = req.body || {};

  if (!imageUrl || !destinationUrl) {
    return res.status(400).json({ error: 'imageUrl and destinationUrl required' });
  }

  const fb = async (endpoint, method = 'GET', body = null) => {
    const url = `${FB_API}${endpoint}${endpoint.includes('?') ? '&' : '?'}access_token=${token}`;
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    const data = await r.json();
    if (data.error) {
      console.error('Full error:', JSON.stringify(data.error));
      throw new Error(`Meta API [${endpoint}]: ${data.error.message} (code ${data.error.code}) type:${data.error.type} — ${JSON.stringify(data.error.error_user_msg || data.error.error_data || '')}`);
    }
    return data;
  };

  try {
    // ── Step 1: Upload image to get hash ──────────────────────────────────────
    console.log('Uploading image to Meta...');
    let imageHash;
    
    // Fetch image and upload as bytes
    const imgRes = await fetch(imageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' },
      signal: AbortSignal.timeout(10000),
    });
    
    if (!imgRes.ok) throw new Error(`Could not fetch image: ${imgRes.status}`);
    
    const imgBuffer = await imgRes.arrayBuffer();
    const imgBase64 = Buffer.from(imgBuffer).toString('base64');
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    
    // Upload via AdImages endpoint using base64 bytes field
    const uploadParams = new URLSearchParams();
    uploadParams.append('bytes', imgBase64);
    uploadParams.append('name', `ad_image_${Date.now()}`);
    uploadParams.append('access_token', token);
    
    const uploadRes = await fetch(
      `${FB_API}/${adAccountId}/adimages`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: uploadParams }
    );
    const uploadData = await uploadRes.json();
    if (uploadData.error) throw new Error(`Image upload: ${uploadData.error.message}`);
    
    // Extract hash from response
    const images = uploadData.images;
    imageHash = images?.[Object.keys(images)[0]]?.hash;
    if (!imageHash) throw new Error('Could not get image hash from Meta');
    console.log('Image hash:', imageHash);

    // ── Step 2: Get or create Campaign ──────────────────────────────────────
    const pageId = process.env.META_PAGE_ID || '143857629020031';
    let campaignId;
    if (existingCampaignId) {
      campaignId = existingCampaignId;
      console.log('Using existing campaign:', campaignId);
    } else {
      console.log('Creating new campaign...');
      const newCampaign = await fb(`/${adAccountId}/campaigns`, 'POST', {
        name: campaignName,
        objective: 'OUTCOME_TRAFFIC',
        status: 'PAUSED',
        special_ad_categories: [],
        buying_type: 'AUCTION',
        is_adset_budget_sharing_enabled: false,
      });
      campaignId = newCampaign.id;
      console.log('New campaign ID:', campaignId);
    }

    // ── Step 3: Get or create Ad Set ─────────────────────────────────────────
    let adSetId;
    if (existingAdSetId) {
      adSetId = existingAdSetId;
      console.log('Using existing ad set:', adSetId);
    } else {
      console.log('Creating new ad set in campaign:', campaignId);
      const newAdSet = await fb(`/${adAccountId}/adsets`, 'POST', {
        name: `${adName} - Ad Set`,
        campaign_id: campaignId,
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'LINK_CLICKS',
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        daily_budget: 1000,
        promoted_object: { page_id: pageId },
        dsa_beneficiary: 'Adspire Deutschland GmbH',
        dsa_payor: 'Adspire Deutschland GmbH',
        targeting: {
          geo_locations: { countries: ['DK'] },
          age_min: 25,
          age_max: 65,
        },
        status: 'PAUSED',
      });
      adSetId = newAdSet.id;
      console.log('New ad set ID:', adSetId);
    }

    // ── Step 4: Create Ad Creative ────────────────────────────────────────────
    console.log('Creating ad creative...');
    let creative;

    if (format === 'carousel' && carouselCards.length > 0) {
      // Upload each carousel card image and get hash
      console.log('Uploading carousel card images...');
      const cardHashes = await Promise.all(
        carouselCards.slice(0, 5).map(async (card) => {
          try {
            const cImgRes = await fetch(card.imageUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0' },
              signal: AbortSignal.timeout(8000),
            });
            if (!cImgRes.ok) return imageHash; // fallback to hero
            const cBuf = await cImgRes.arrayBuffer();
            const cB64 = Buffer.from(cBuf).toString('base64');
            const cParams = new URLSearchParams();
            cParams.append('bytes', cB64);
            cParams.append('name', 'carousel_' + Date.now() + '_' + Math.random());
            cParams.append('access_token', token);
            const cRes = await fetch(`${FB_API}/${adAccountId}/adimages`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: cParams,
            });
            const cData = await cRes.json();
            const hash = cData.images?.[Object.keys(cData.images||{})[0]]?.hash;
            return hash || imageHash;
          } catch { return imageHash; }
        })
      );
      console.log('Card hashes:', cardHashes.length);

      // Carousel creative
      creative = await fb(`/${adAccountId}/adcreatives`, 'POST', {
        name: `${adName} - Creative`,
        object_story_spec: {
          page_id: pageId,
          link_data: {
            message: primaryText,
            child_attachments: carouselCards.slice(0, 5).map((card, ci) => ({
              link: card.url || destinationUrl,
              name: (card.headline || headline)?.slice(0, 40),
              description: (card.description || description)?.slice(0, 30),
              image_hash: cardHashes[ci] || imageHash,
              call_to_action: { type: 'SHOP_NOW', value: { link: card.url || destinationUrl } },
            })),
            multi_share_optimized: false,
            link: destinationUrl,
          },
        },
      });
    } else {
      // Single image creative
      creative = await fb(`/${adAccountId}/adcreatives`, 'POST', {
        name: `${adName} - Creative`,
        object_story_spec: {
          page_id: pageId,
          link_data: {
            message: primaryText,
            link: destinationUrl,
            name: headline,
            description: description,
            image_hash: imageHash,
            call_to_action: {
              type: 'LEARN_MORE',
              value: { link: destinationUrl },
            },
          },
        },
      });
    }
    console.log('Creative ID:', creative.id);

    // ── Step 5: Create Ad ─────────────────────────────────────────────────────
    console.log('Creating ad...');
    const ad = await fb(`/${adAccountId}/ads`, 'POST', {
      name: adName,
      adset_id: adSetId,
      creative: { creative_id: creative.id },
      status: 'PAUSED',
    });
    console.log('Ad ID:', ad.id);

    return res.status(200).json({
      success: true,
      campaignId: campaignId,
      adSetId: adSetId,
      creativeId: creative.id,
      adId: ad.id,
      adsManagerUrl: `https://www.facebook.com/adsmanager/manage/ads?act=${adAccountId.replace('act_', '')}&selected_ad_ids=${ad.id}`,
      message: 'Ad created as PAUSED — review in Ads Manager before activating',
    });

  } catch (err) {
    console.error('Meta publish error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function getPageId(token, adAccountId) {
  // Get the first page associated with this ad account
  const res = await fetch(
    `https://graph.facebook.com/v19.0/me/accounts?access_token=${token}`
  );
  const data = await res.json();
  if (data.data?.[0]?.id) return data.data[0].id;
  throw new Error('No Facebook Page found. Please create a Page or connect one to your Business Manager.');
}

// Add GET handler for diagnostics
export const config = { api: { bodyParser: true } };
