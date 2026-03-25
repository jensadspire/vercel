/**
 * /api/audience — AI-powered audience brief generator
 * Input:  { url, pageContent, audienceDescription, language }
 * Output: { brief, metaDescription, interests, demographics, toneSignals }
 */

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const { url, pageContent = '', audienceDescription = '', language = 'English' } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });

  const prompt = `You are an expert digital advertising strategist specialising in Meta (Facebook & Instagram) audience targeting.

Analyse this product/service page and the advertiser's audience description, then build a detailed audience brief.

Page URL: ${url}
Page content: ${pageContent.slice(0, 2000)}
Advertiser's audience description: ${audienceDescription || 'Not provided — infer from page content'}

Return ONLY a valid JSON object (no markdown, no preamble):
{
  "audienceName": "Short descriptive name for this audience (max 6 words)",
  "metaDescription": "Ready-to-paste description for Meta's Advantage+ Audience 'Describe Your Audience' field (2-3 sentences, natural language, specific and actionable)",
  "demographics": {
    "ageRange": "e.g. 25-44",
    "gender": "All | Male | Female",
    "locations": ["primary market 1", "primary market 2"],
    "income": "e.g. Middle to upper-middle income"
  },
  "psychographics": ["trait 1", "trait 2", "trait 3", "trait 4"],
  "interests": ["interest 1", "interest 2", "interest 3", "interest 4", "interest 5"],
  "behaviors": ["behavior 1", "behavior 2", "behavior 3"],
  "painPoints": ["pain point 1", "pain point 2", "pain point 3"],
  "motivations": ["motivation 1", "motivation 2", "motivation 3"],
  "messagingTone": "e.g. Aspirational and energetic, speaks to achievement",
  "copySignals": ["copy angle 1", "copy angle 2", "copy angle 3"],
  "excludeAudiences": ["audience to exclude 1", "audience to exclude 2"]
}

Write in ${language}. Be specific and actionable — avoid generic marketing language.`;

  try {
    const r = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await r.json();
    const text = data.content?.[0]?.text || '';

    let brief;
    try {
      const clean = text.replace(/```json|```/g, '').trim();
      brief = JSON.parse(clean);
    } catch {
      return res.status(500).json({ error: 'Failed to parse audience brief' });
    }

    return res.status(200).json(brief);

  } catch (err) {
    console.error('Audience brief error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
