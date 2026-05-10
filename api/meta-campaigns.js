/**
 * /api/meta-campaigns — Fetch active campaigns from Meta Ads account
 * GET → { campaigns: [{ id, name, objective, status }] }
 */
const FB_API = 'https://graph.facebook.com/v19.0';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.META_ACCESS_TOKEN;
  const adAccountId = process.env.META_AD_ACCOUNT_ID;
  if (!token || !adAccountId) return res.status(500).json({ error: 'Meta credentials not configured' });

  try {
    const r = await fetch(
      `${FB_API}/${adAccountId}/campaigns?fields=id,name,objective,status&filtering=[{"field":"effective_status","operator":"IN","value":["ACTIVE","PAUSED"]}]&limit=50&access_token=${token}`
    );
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    return res.status(200).json({ campaigns: data.data || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
