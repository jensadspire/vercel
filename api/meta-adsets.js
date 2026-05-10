/**
 * /api/meta-adsets — Fetch ad sets for a given campaign
 * GET ?campaignId=xxx → { adsets: [{ id, name, status }] }
 */
const FB_API = 'https://graph.facebook.com/v19.0';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.META_ACCESS_TOKEN;
  const { campaignId } = req.query;
  if (!token || !campaignId) return res.status(400).json({ error: 'Missing token or campaignId' });

  try {
    const r = await fetch(
      `${FB_API}/${campaignId}/adsets?fields=id,name,status,daily_budget,targeting&filtering=[{"field":"effective_status","operator":"IN","value":["ACTIVE","PAUSED"]}]&limit=50&access_token=${token}`
    );
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    return res.status(200).json({ adsets: data.data || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
