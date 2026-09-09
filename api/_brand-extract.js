/**
 * _brand-extract.js — best-effort brand colour + font extraction.
 *
 * Helper (not an endpoint), same shape as _ai-label.js. Given a logo image URL
 * and optionally the page HTML, returns { colors, fonts } as SUGGESTIONS for the
 * user to confirm/edit in the Assets tab (never treated as definitive).
 *
 * Why this design (learned the hard way): modern e-commerce sites are JS-rendered,
 * so scraping CSS for colours returns nothing on most real storefronts. Instead:
 *   - COLOURS come from the LOGO IMAGE (which /api/scrape already reliably extracts
 *     via OG tags/JSON-LD that survive on JS sites) using sharp — robust everywhere.
 *   - THEME-COLOR meta + Google-Fonts links are grabbed from server HTML as cheap
 *     bonus signals WHERE PRESENT (they often are, being SEO/PWA tags).
 *   - FONTS are best-effort only; where not found, the UI falls back to manual entry.
 *
 * Everything fails soft: any step that can't produce a result just contributes
 * nothing, so the caller always gets a well-formed (possibly empty) object.
 */

// Extract the dominant colour palette from an image URL using sharp.
// Downsamples, quantizes to reduce noise, returns up to `n` hex colours by frequency.
async function colorsFromImage(imageUrl, n = 5) {
  if (!imageUrl) return [];
  try {
    const sharp = (await import('sharp')).default;
    const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return [];
    const input = Buffer.from(await resp.arrayBuffer());

    const { data, info } = await sharp(input)
      .resize(64, 64, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const ch = info.channels;
    const buckets = {};
    for (let i = 0; i < data.length; i += ch) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const a = ch === 4 ? data[i + 3] : 255;
      if (a < 128) continue;                       // skip transparent pixels
      // Skip near-white and near-black (usually background/text, not brand colour)
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (max > 244 && min > 244) continue;        // near-white
      if (max < 12) continue;                      // near-black
      const key = [Math.round(r / 24) * 24, Math.round(g / 24) * 24, Math.round(b / 24) * 24].join(',');
      buckets[key] = (buckets[key] || 0) + 1;
    }
    const top = Object.entries(buckets).sort((a, b) => b[1] - a[1]).slice(0, n);
    return top.map(([k]) => {
      const [r, g, b] = k.split(',').map(Number);
      return '#' + [r, g, b].map(x => Math.min(255, x).toString(16).padStart(2, '0')).join('');
    });
  } catch (e) {
    console.error('[brand-extract] colour extraction failed (soft):', e.message);
    return [];
  }
}

// Pull theme-color meta + Google Fonts families from server HTML (where present).
function signalsFromHtml(html) {
  const out = { themeColor: null, fonts: [] };
  if (!html || typeof html !== 'string') return out;
  try {
    out.themeColor =
      html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']theme-color["']/i)?.[1] ||
      null;

    const fonts = new Set();
    // Google Fonts <link href="...css2?family=Inter:wght@400...">
    for (const m of html.matchAll(/fonts\.googleapis\.com\/css2?\?family=([^"'&]+)/gi)) {
      const fam = decodeURIComponent(m[1]).split(':')[0].replace(/\+/g, ' ').trim();
      if (fam) fonts.add(fam);
    }
    // First font-family declaration(s) in inline styles, if any survived in server HTML
    for (const m of html.matchAll(/font-family\s*:\s*([^;}"']+)/gi)) {
      const first = (m[1].split(',')[0] || '').trim().replace(/['"]/g, '');
      if (first && !/^(inherit|initial|unset|var|-apple|system|sans|serif|monospace)/i.test(first)) fonts.add(first);
      if (fonts.size >= 5) break;
    }
    out.fonts = [...fonts].slice(0, 5);
  } catch (e) {
    console.error('[brand-extract] html signal parse failed (soft):', e.message);
  }
  return out;
}

/**
 * Main entry: given { logoUrl, html }, return brand suggestions.
 *   → { colors: [hex...], fonts: [name...], source: {...} }
 * colours = theme-color (if present, first) + palette from the logo image.
 */
export async function extractBrandSignals({ logoUrl = null, html = null } = {}) {
  const htmlSignals = signalsFromHtml(html);
  const imageColors = await colorsFromImage(logoUrl);

  // Compose colour suggestions: theme-color first (strong signal), then logo palette,
  // deduped, capped at 6.
  const colors = [];
  const pushColor = (c) => {
    if (!c) return;
    const norm = c.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(norm) && !colors.includes(norm)) colors.push(norm);
  };
  pushColor(htmlSignals.themeColor);
  imageColors.forEach(pushColor);

  return {
    colors: colors.slice(0, 6),
    fonts: htmlSignals.fonts,
    source: {
      themeColor: htmlSignals.themeColor,
      logoPalette: imageColors,
      note: 'Suggestions for user confirmation — not definitive.',
    },
  };
}
