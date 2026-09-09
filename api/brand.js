/**
 * /api/brand — per-user Brand & Context record (Phase 1 foundation)
 *
 * Stores one brand profile per signed-in user in Upstash Redis, keyed by the
 * Clerk user id. Binary assets (logo, reference images) live in Vercel Blob
 * under brands/{userId}/... ; this endpoint stores the STRUCTURED metadata
 * (colours, font, CTA, context) plus the Blob URLs pointing at those assets.
 *
 *   GET  /api/brand            → { brand }        (the caller's own record, or an empty template)
 *   POST /api/brand  { ...fields }  → { brand }   (merge-saves the caller's record)
 *
 * Identity & isolation: the record key is derived SERVER-SIDE from the Clerk
 * session JWT (x-clerk-session). A user can only ever read/write their own
 * brand:{userId} record — the client never supplies the userId. Same isolation
 * mechanism as the Recipe meter.
 *
 * Fail posture (deliberately different per direction):
 *   - READ  fails soft  → return an empty brand template if Redis is unreachable,
 *                         so the UI still renders (user just sees nothing saved yet).
 *   - WRITE fails hard  → return 503 so the user KNOWS their save didn't persist
 *                         (a silently-dropped save would be worse than an error).
 *
 * Data model (brand:{userId} → JSON):
 *   {
 *     userId, logo, colors[], font, ctaText, referenceImages[],
 *     context: { objective, tonePreset, guardrails, styleTags[] },
 *     updatedAt
 *   }
 * Designed as a record that BELONGS TO a user (not fields on the user), so the
 * agency tier can later allow many brands per user without a data reshape.
 */

const BRAND_TTL_SECS = 0; // 0 = no expiry; brand records persist until changed/deleted

// ── Upstash Redis helper (same REST pattern as /api/runway-recipe) ───────────
async function redis(command, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { ok: false, result: null };
  const res = await fetch(`${url}/${[command, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`redis ${command} http ${res.status}`);
  const data = await res.json();
  return { ok: true, result: data.result };
}

// Decode Clerk session JWT → user id (payload.sub), or null. (Same decode as recipe.)
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

// The canonical empty record (also the shape the UI can rely on always existing).
function emptyBrand(userId) {
  return {
    userId,
    logo: null,
    colors: [],
    font: null,
    ctaText: null,
    referenceImages: [],
    context: { objective: null, tonePreset: null, guardrails: null, styleTags: [] },
    updatedAt: null,
  };
}

// Whitelist + shape incoming fields so a client can't write arbitrary keys.
function sanitize(input, userId) {
  // Return ONLY the fields actually present in input (not a full template), so
  // the caller's merge logic can distinguish "sent" from "absent" and never
  // overwrites an untouched field with a default. context is likewise sparse.
  const b = {};
  if (input && typeof input === 'object') {
    if (typeof input.logo === 'string') b.logo = input.logo.slice(0, 1000);
    if (Array.isArray(input.colors)) b.colors = input.colors.filter(c => typeof c === 'string').slice(0, 12).map(c => c.slice(0, 16));
    if (typeof input.font === 'string') b.font = input.font.slice(0, 120);
    if (typeof input.ctaText === 'string') b.ctaText = input.ctaText.slice(0, 200);
    if (Array.isArray(input.referenceImages)) b.referenceImages = input.referenceImages.filter(u => typeof u === 'string').slice(0, 10).map(u => u.slice(0, 1000));
    if (input.context && typeof input.context === 'object') {
      const c = input.context;
      b.context = {};
      if (typeof c.objective === 'string') b.context.objective = c.objective.slice(0, 2000);
      if (typeof c.tonePreset === 'string') b.context.tonePreset = c.tonePreset.slice(0, 120);
      if (typeof c.guardrails === 'string') b.context.guardrails = c.guardrails.slice(0, 2000);
      if (Array.isArray(c.styleTags)) b.context.styleTags = c.styleTags.filter(t => typeof t === 'string').slice(0, 20).map(t => t.slice(0, 60));
    }
  }
  return b;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-clerk-session');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Identity is derived server-side; brand is a signed-in-only feature.
  const userId = clerkUserId(req);
  if (!userId) return res.status(401).json({ error: 'Sign in required.' });

  const key = `brand:${userId}`;

  // ── GET: read the caller's own record (fail soft) ──────────────────────────
  if (req.method === 'GET') {
    try {
      const got = await redis('GET', key);
      if (got.ok && got.result) {
        try { return res.status(200).json({ brand: JSON.parse(got.result) }); }
        catch { return res.status(200).json({ brand: emptyBrand(userId) }); }
      }
      // No record yet → return the empty template so the UI always has a shape.
      return res.status(200).json({ brand: emptyBrand(userId) });
    } catch (e) {
      // Fail soft: UI still renders; user just sees nothing saved.
      console.error('brand GET failed (soft):', e.message);
      return res.status(200).json({ brand: emptyBrand(userId), degraded: true });
    }
  }

  // ── POST: merge-save the caller's record (fail hard) ───────────────────────
  if (req.method === 'POST') {
    // Merge onto whatever exists so a partial save (e.g. only the Assets tab)
    // doesn't wipe fields owned by another tab (e.g. Context).
    let existing = emptyBrand(userId);
    try {
      const got = await redis('GET', key);
      if (got.ok && got.result) { try { existing = JSON.parse(got.result); } catch {} }
    } catch (e) {
      // If we can't read the current record, don't blind-overwrite it.
      console.error('brand POST pre-read failed (hard):', e.message);
      return res.status(503).json({ error: 'Could not save right now — please try again shortly.' });
    }

    const incoming = sanitize(req.body, userId);   // sparse: only fields actually sent
    // Merge sparse incoming onto existing so a partial save (one tab, or one
    // context field) never wipes fields it didn't touch.
    const merged = { ...emptyBrand(userId), ...existing };  // ensure full shape
    if ('logo' in incoming) merged.logo = incoming.logo;
    if ('colors' in incoming) merged.colors = incoming.colors;
    if ('font' in incoming) merged.font = incoming.font;
    if ('ctaText' in incoming) merged.ctaText = incoming.ctaText;
    if ('referenceImages' in incoming) merged.referenceImages = incoming.referenceImages;
    if (incoming.context) {
      // Deep-merge only the context fields that were actually sent.
      merged.context = { ...(existing.context || emptyBrand(userId).context), ...incoming.context };
    }
    merged.userId = userId;
    merged.updatedAt = new Date().toISOString();

    try {
      const payload = JSON.stringify(merged);
      if (BRAND_TTL_SECS > 0) await redis('SET', key, payload, 'EX', BRAND_TTL_SECS);
      else await redis('SET', key, payload);
      return res.status(200).json({ brand: merged });
    } catch (e) {
      console.error('brand POST write failed (hard):', e.message);
      return res.status(503).json({ error: 'Could not save right now — please try again shortly.' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
