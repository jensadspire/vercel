/**
 * /api/pexels-search  —  server-side Pexels proxy for the Recipe UGC picker.
 *
 * Keeps PEXELS_API_KEY server-side (it must NEVER ship to the browser).
 * Called from App.jsx (Recipe UGC creator-image picker).
 *
 *   POST { query?: string, page?: number, perPage?: number, orientation?: string }
 *     - query present  → Pexels /v1/search  (biased to portrait for person shots)
 *     - query empty    → Pexels /v1/curated (the default "browse" feed)
 *
 * Returns: { photos: [{ id, thumb, src, alt, photographer, photographerUrl }] }
 *   thumb = small image for the grid; src = larger image handed to Recipe.
 *
 * Pexels API guidelines ask that we credit Pexels + the photographer when
 * showing results — the picker surfaces the photographer name and a Pexels link.
 */

const PEXELS_BASE = 'https://api.pexels.com/v1';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const KEY = process.env.PEXELS_API_KEY;
  if (!KEY) {
    return res.status(500).json({ error: 'Pexels is not configured (missing API key).' });
  }

  // Vercel usually parses JSON bodies, but be defensive.
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const query = (body.query || '').toString().trim();
  const page = Math.min(Math.max(parseInt(body.page, 10) || 1, 1), 50);
  const perPage = Math.min(Math.max(parseInt(body.perPage, 10) || 16, 1), 24);
  // Portrait suits vertical UGC / face references; only applies to search.
  const orientation = ['portrait', 'landscape', 'square'].includes(body.orientation)
    ? body.orientation : 'portrait';

  let url;
  if (query) {
    const params = new URLSearchParams({
      query,
      per_page: String(perPage),
      page: String(page),
      orientation,
    });
    url = `${PEXELS_BASE}/search?${params.toString()}`;
  } else {
    const params = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
    });
    url = `${PEXELS_BASE}/curated?${params.toString()}`;
  }

  try {
    const r = await fetch(url, { headers: { Authorization: KEY } });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return res.status(502).json({ error: `Pexels error ${r.status}`, detail: txt.slice(0, 200) });
    }
    const data = await r.json();
    const photos = (data.photos || []).map(p => ({
      id: p.id,
      thumb: p.src?.small || p.src?.tiny || p.src?.medium || '',
      src: p.src?.large || p.src?.portrait || p.src?.original || '',
      alt: p.alt || '',
      photographer: p.photographer || '',
      photographerUrl: p.photographer_url || '',
    })).filter(p => p.src && p.thumb);

    return res.status(200).json({ photos });
  } catch (e) {
    return res.status(500).json({ error: 'Pexels request failed', detail: String(e.message || e).slice(0, 200) });
  }
}
