/**
 * /api/brand-detect — auto-detect brand assets from a domain via Brandfetch.
 *
 * Server-side only: the Brandfetch API key lives in process.env and NEVER reaches
 * the browser. The panel calls this with a domain; we call Brandfetch, clean the
 * (often messy) response into confirm-ready suggestions, and return them.
 *
 *   POST /api/brand-detect  { domain: "dilling.com" }  (signed-in only)
 *     → { suggestions: { logo, colors[], font, fonts[] }, quality, full }
 *
 * Cleaning applied (learned from real-brand testing — Brandfetch data is ~0.55
 * quality on small e-commerce brands, and fonts often come back as raw CSS vars):
 *   - fonts: "var(--font-playfair-display)" → "Playfair Display"
 *   - logo:  prefer type "logo" (light theme, raster) → fallback symbol → icon
 *   - colors: accent/brand first (primaries), then dark/light neutrals
 *   - quality: passed through so the UI can flag low-confidence detections
 *
 * Everything is a SUGGESTION for the user to confirm/edit — never auto-applied.
 */

// Decode Clerk session JWT → user id (same as /api/brand). Signed-in only.
function clerkUserId(req) {
  const tok = req.headers['x-clerk-session'] || '';
  if (!tok) return null;
  try {
    const parts = tok.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.sub && payload.exp && payload.exp > now) return payload.sub;
  } catch (_) {}
  return null;
}

// "var(--font-playfair-display)" → "Playfair Display"; passes clean names through.
function cleanFontName(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  const m = s.match(/var\(\s*--(?:font-)?([a-z0-9-]+)\s*\)/i);
  if (m) s = m[1];
  // strip common prefixes/suffixes, turn dashes/underscores into spaces
  s = s.replace(/^font-/i, '').replace(/[-_]+/g, ' ').trim();
  if (!s) return null;
  // title-case each word
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

// Normalize a domain from whatever the user typed (url or bare domain).
function normalizeDomain(input) {
  if (!input || typeof input !== 'string') return null;
  let d = input.trim().toLowerCase();
  try {
    if (d.startsWith('http')) d = new URL(d).hostname;
  } catch (_) {}
  d = d.replace(/^www\./, '').replace(/\/.*$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

// Pick the best single logo URL: prefer type=logo, light theme, raster (png/webp),
// largest reasonable size; fall back to symbol, then icon, then anything.
function pickLogo(logos) {
  if (!Array.isArray(logos) || !logos.length) return null;
  const typeRank = { logo: 0, symbol: 1, icon: 2, other: 3 };
  const themeRank = { light: 0, dark: 1 };
  const fmtRank = { png: 0, webp: 1, jpeg: 2, jpg: 2, svg: 3 }; // raster first for overlay use

  const candidates = [];
  for (const l of logos) {
    for (const f of (l.formats || [])) {
      if (!f.src) continue;
      candidates.push({
        src: f.src,
        _t: typeRank[l.type] ?? 4,
        _th: themeRank[l.theme] ?? 2,
        _f: fmtRank[(f.format || '').toLowerCase()] ?? 4,
        _area: (f.width || 0) * (f.height || 0),
      });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) =>
    a._t - b._t || a._th - b._th || a._f - b._f || b._area - a._area
  );
  return candidates[0].src;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-clerk-session');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!clerkUserId(req)) return res.status(401).json({ error: 'Sign in required.' });

  const key = process.env.BRANDFETCH_API_KEY;
  if (!key) return res.status(500).json({ error: 'Brand detection not configured.' });

  const domain = normalizeDomain((req.body || {}).domain);
  if (!domain) return res.status(400).json({ error: 'A valid domain or URL is required.' });

  try {
    const bfRes = await fetch(`https://api.brandfetch.io/v2/brands/domain/${encodeURIComponent(domain)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(12000),
    });

    if (bfRes.status === 404) {
      return res.status(200).json({ suggestions: null, quality: 0, notFound: true,
        message: `We couldn't find brand data for ${domain}. You can enter details manually.` });
    }
    if (bfRes.status === 429) {
      return res.status(200).json({ suggestions: null, error: 'Brand detection is temporarily rate-limited — please enter details manually or try again later.' });
    }
    if (!bfRes.ok) {
      return res.status(200).json({ suggestions: null, error: `Brand detection unavailable (status ${bfRes.status}). Enter details manually.` });
    }

    const data = await bfRes.json();

    // ── Clean into confirm-ready suggestions ──
    const logo = pickLogo(data.logos);

    const colorsRanked = (Array.isArray(data.colors) ? data.colors : [])
      .slice()
      .sort((a, b) => {
        const rank = { accent: 0, brand: 1, dark: 2, light: 3 };
        return (rank[a.type] ?? 4) - (rank[b.type] ?? 4);
      })
      .map(c => c.hex)
      .filter(h => /^#[0-9a-fA-F]{6}$/.test(h || ''));

    const fontsClean = (Array.isArray(data.fonts) ? data.fonts : [])
      .map(f => ({ name: cleanFontName(f.name), type: f.type }))
      .filter(f => f.name);
    // Primary font suggestion = the title font if present, else the first.
    const titleFont = fontsClean.find(f => f.type === 'title');
    const primaryFont = (titleFont || fontsClean[0])?.name || null;

    return res.status(200).json({
      suggestions: {
        logo,
        colors: colorsRanked,      // ranked: accent/brand first, then neutrals
        font: primaryFont,         // single best font for the flat v1 field
        fonts: fontsClean,         // full [{name,type}] for the future variations UI
      },
      quality: typeof data.qualityScore === 'number' ? data.qualityScore : null,
      // Full structured data stored behind the flat fields for later (variations UI).
      full: {
        logos: data.logos || [],
        colors: data.colors || [],
        fonts: fontsClean,
        name: data.name || null,
        domain: data.domain || domain,
      },
    });
  } catch (err) {
    console.error('[brand-detect] error:', err?.message || err);
    return res.status(200).json({ suggestions: null, error: 'Brand detection failed — please enter details manually.' });
  }
}
