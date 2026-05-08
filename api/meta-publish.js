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
    if (data.error) throw new Error(`Meta API [${endpoint}]: ${data.error.message} (code ${data.error.code}) — ${JSON.stringify(data.error.error_data || '')}`);
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

    // ── Step 2: Create Campaign (PAUSED for safety) ───────────────────────────
    console.log('Image hash obtained:', imageHash);
    console.log('Creating campaign...');
    const campaign = await fb(`/${adAccountId}/campaigns`, 'POST', {
      name: campaignName,
      objective: 'OUTCOME_TRAFFIC',
      status: 'PAUSED',
      special_ad_categories: [],
    });
    console.log('Campaign ID:', campaign.id);

    // ── Step 3: Create Ad Set ─────────────────────────────────────────────────
    console.log('Creating ad set...');
    const adSet = await fb(`/${adAccountId}/adsets`, 'POST', {
      name: `${adName} - Ad Set`,
      campaign_id: campaign.id,
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'LINK_CLICKS',
      bid_amount: 200, // 2.00 in account currency
      daily_budget: 1000, // 10.00 in account currency
      targeting: {
        geo_locations: { countries: ['DK'] },
        age_min: 25,
        age_max: 65,
      },
      status: 'PAUSED',
    });
    console.log('Ad Set ID:', adSet.id);

    // ── Step 4: Create Ad Creative ────────────────────────────────────────────
    console.log('Creating ad creative...');
    let creative;

    if (format === 'carousel' && carouselCards.length > 0) {
      // Carousel creative
      creative = await fb(`/${adAccountId}/adcreatives`, 'POST', {
        name: `${adName} - Creative`,
        object_story_spec: {
          page_id: await getPageId(token, adAccountId),
          link_data: {
            message: primaryText,
            child_attachments: carouselCards.slice(0, 5).map(card => ({
              link: card.url || destinationUrl,
              name: card.headline || headline,
              description: card.description || description,
              image_hash: imageHash, // Will be per-card in full implementation
            })),
            multi_share_optimized: true,
          },
        },
      });
    } else {
      // Single image creative
      creative = await fb(`/${adAccountId}/adcreatives`, 'POST', {
        name: `${adName} - Creative`,
        object_story_spec: {
          page_id: await getPageId(token, adAccountId),
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
      adset_id: adSet.id,
      creative: { creative_id: creative.id },
      status: 'PAUSED',
    });
    console.log('Ad ID:', ad.id);

    return res.status(200).json({
      success: true,
      campaignId: campaign.id,
      adSetId: adSet.id,
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
