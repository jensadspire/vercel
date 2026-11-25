// /api/presenter-script.js — auto-write a short SPOKEN voiceover script for the live-presenter ad.
// Sources the product-page body (via /api/scrape, like the Meta generator) as the PRIMARY material,
// flavoured by title + meta description. Two styles: 'product' (title → benefits → features → CTA)
// and 'hook' (opening question / intrigue → benefit → CTA). Clean spoken copy (no emoji/symbols),
// sized to ~targetWords (~14s) so it fits the ~15s clip and clears lipsync's 15% duration rule.
//
//   POST { url|productUrl?, language?, style?, context?, targetWords? } -> { ok, script, words, style }
//
// Env: ANTHROPIC_API_KEY.

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const language = (body.language && String(body.language).trim()) || 'English';
    const style = (String(body.style || 'product').toLowerCase() === 'hook') ? 'hook' : 'product';
    const targetWords = Math.max(20, Math.min(60, Math.round(Number(body.targetWords) || 38)));
    const url = String(body.url || body.productUrl || '').slice(0, 500);
    let context = String(body.context || '').slice(0, 2000);

    // PRIMARY source: scrape the product page body (same endpoint the Meta flow uses).
    let content = '', title = '', metaDescription = '';
    if (url) {
      try {
        const origin = req.headers.origin || ('https://' + req.headers.host);
        const sr = await fetch(origin + '/api/scrape', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
        });
        const sd = await sr.json().catch(() => ({}));
        content = String(sd.content || sd.text || '').slice(0, 6000);
        title = String(sd.title || '').slice(0, 300);
        metaDescription = String(sd.metaDescription || '').slice(0, 600);
      } catch (_) { /* fall back to context */ }
    }
    const primary = content || context || url || '(no product detail available)';

    const common =
      '- Write the script in ' + language + '.\n' +
      '- About ' + targetWords + ' words (within a few words), so it reads aloud in roughly 13 to 15 seconds.\n' +
      '- Natural spoken style — the way a real person talks straight to camera. Warm, confident, specific to this product.\n' +
      '- Absolutely NO emojis and NO symbols such as %, +, =, &, # — no hashtags, no URLs, no stage directions, no quotation marks. Write any figures and their units as spoken words.\n' +
      '- Output ONLY the script text itself — no preamble, no labels, no quotes.';

    const flow = style === 'hook'
      ? ('STYLE — HOOK:\n' +
         '1) Open with a short, intriguing question or a pattern-interrupt line that speaks to the viewer\'s desire or problem.\n' +
         '2) Answer it with the product and its main benefit.\n' +
         '3) One concrete feature or proof point.\n' +
         '4) End with a short, natural call to action.')
      : ('STYLE — PRODUCT:\n' +
         '1) Open naturally with the product (use its title/name).\n' +
         '2) The main user benefit — the real reason to care.\n' +
         '3) One or two concrete features or ingredients / what the product represents.\n' +
         '4) End with a short, natural call to action.');

    const prompt =
      'You are writing a short SPOKEN voiceover script for a video ad in which a presenter holds the product and talks straight to camera.\n\n' +
      'PRIMARY SOURCE — base the script on this product-page content:\n' + primary + '\n\n' +
      (title ? ('PRODUCT TITLE (use as a natural opening when it fits): ' + title + '\n') : '') +
      (metaDescription ? ('META DESCRIPTION (flavour only): ' + metaDescription + '\n') : '') +
      '\n' + flow + '\n\nREQUIREMENTS:\n' + common;

    const r = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j && j.error && (j.error.message || j.error)) || ('HTTP ' + r.status);
      return res.status(502).json({ error: 'Copy generation failed: ' + msg });
    }
    let script = '';
    try { script = (j.content || []).map(function (b) { return b && b.text ? b.text : ''; }).join('').trim(); } catch (_) {}
    script = script.replace(/^["'“”]+/, '').replace(/["'“”]+$/, '').trim();
    if (!script) return res.status(502).json({ error: 'Empty script returned' });
    const words = script.split(/\s+/).filter(Boolean).length;
    return res.status(200).json({ ok: true, script, words, style });
  } catch (err) {
    console.error('[presenter-script] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
