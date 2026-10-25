/**
 * /api/creatives — Creative / Ad Library store (Phase 1: Upstash Redis).
 *
 * Sibling of /api/characters: the durable store for APPROVED ads (one record = one full
 * ad bundle — Google + Meta + Video). Owner-scoped (Clerk user) with an optional agencyId
 * parent for later agency-level visibility. Dimensions (domain / publishStatus / engine /
 * vertical / language / promo / persona) are indexed as Redis sets so faceted filtering is a
 * SINTER — no query engine. Binaries already live at stable URLs (video on Blob via the
 * AI-label step; Meta/feed images on CDN), so we store the URLs; Blob-copy hardening later.
 *
 * Write-on-Approve: a record is created when the user approves a staged ad. Versioning by
 * lineage — each Edit writes a NEW record sharing rootId, version bumped, isLatest moved.
 *
 * Storage model (see creative-library-contract.md):
 *   creative:{id}                              → JSON doc (GLOBAL key — id is a UUID)
 *   idx:creative:owner:{ownerId}               → set of ids owned by a user (the Library list)
 *   idx:creative:agency:{agencyId}             → set of ids under an agency (visibility rollup)
 *   idx:creative:root:{rootId}                 → all versions of one ad
 *   tag:creative:owner:{ownerId}:{dim}:{value} → faceted-filter set (owner-scoped)
 *
 * Actions (POST body.action): save (create/update = Approve) | list | get | delete.
 * Auth: x-clerk-session JWT decode -> payload.sub (same pattern as /api/characters).
 */

import { randomUUID } from 'node:crypto';

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } }, // the channels bundle (copy + URLs) is bigger than a character doc
};

// ── Upstash Redis helper (REST — same pattern as /api/characters, /api/scrape) ──
async function redis(command, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/${[command, ...args].map(encodeURIComponent).join('/')}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data.result;
  } catch (_) { return null; }
}

// Decode Clerk session JWT -> user id (payload.sub), or null. (Same as /api/characters.)
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

const str = (v, n) => (v === undefined || v === null ? '' : String(v)).slice(0, n);

// Clamp a user score to an integer 0–10, or null when cleared/invalid.
function clampScore(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(10, n));
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return ''; }
}

// Owner-scoped tag-set keys for a creative's filterable dimensions.
function tagKeys(ownerId, c) {
  const keys = [];
  const base = `tag:creative:owner:${ownerId}`;
  const add = (dim, val) => {
    if (val === undefined || val === null || val === '') return;
    keys.push(`${base}:${dim}:${String(val).toLowerCase()}`);
  };
  add('domain', c.domain);
  add('status', c.publishStatus);          // published | unpublished
  add('engine', c.engine);
  add('vertical', c.vertical);
  add('language', c.language);
  add('promo', c.promo ? 1 : 0);           // always indexed (0/1)
  add('persona', c.personaUsed ? 1 : 0);   // always indexed (0/1)
  return keys;
}

// Light projection for list views — drop the heavy channels bundle, keep a thumbnail.
function toCard(doc) {
  const ch = doc.channels || {};
  const thumb = (ch.meta && ch.meta.imageUrl) || (ch.video && ch.video.url) || doc.thumb || null;
  const { channels, ...rest } = doc;
  return { ...rest, thumb, hasVideo: !!(ch.video && ch.video.url) };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-clerk-session, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth — the Library is a signed-in feature.
  const ownerId = clerkUserId(req);
  if (!ownerId) return res.status(401).json({ error: 'Sign in required.' });

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(503).json({ error: 'Storage temporarily unavailable — please try again shortly.' });
  }

  const body = req.body || {};
  const action = body.action || 'list';

  try {
    // ── SAVE (create on Approve, or update an existing record) ─────────────────
    if (action === 'save') {
      const id = body.id || `crv_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const docKey = `creative:${id}`;

      let existing = null;
      const existingRaw = await redis('GET', docKey);
      if (existingRaw) { try { existing = JSON.parse(existingRaw); } catch (_) {} }
      if (existing && existing.ownerId !== ownerId) {
        return res.status(403).json({ error: 'Not your ad.' });
      }
      if (existing) {
        // Clear old tag memberships before re-indexing (dimensions may have changed, e.g. publishStatus).
        await Promise.all(tagKeys(ownerId, existing).map(k => redis('SREM', k, id)));
      }

      const now = new Date().toISOString();
      const productUrl = str(body.productUrl, 1000);
      const doc = {
        // identity & lineage
        id,
        rootId: body.rootId || (existing && existing.rootId) || id,
        version: Number.isInteger(body.version) ? body.version : (existing ? (existing.version || 0) : 0),
        isLatest: body.isLatest !== undefined ? !!body.isLatest : (existing ? existing.isLatest !== false : true),
        variationOf: body.variationOf || (existing && existing.variationOf) || null,

        // ownership & access
        ownerId,
        agencyId: body.agencyId || (existing && existing.agencyId) || null,

        // timestamps
        createdAt: existing ? existing.createdAt : (body.createdAt || now),
        savedAt: existing ? (existing.savedAt || now) : now,

        // status & publish
        status: body.status || (existing && existing.status) || 'approved',
        publishStatus: body.publishStatus || (existing && existing.publishStatus) || 'unpublished',
        publishedAt: body.publishedAt || (existing && existing.publishedAt) || null,
        publish: body.publish || (existing && existing.publish) || { googleId: null, metaAdId: null, tiktokId: null },

        // source & product
        inputSource: body.inputSource || (existing && existing.inputSource) || 'feed',
        productUrl,
        domain: str(body.domain, 200) || domainOf(productUrl) || (existing && existing.domain) || '',
        productTitle: str(body.productTitle, 300) || (existing && existing.productTitle) || '',
        vertical: str(body.vertical, 80) || (existing && existing.vertical) || '',
        language: str(body.language, 40) || (existing && existing.language) || 'English',
        promo: body.promo !== undefined ? !!body.promo : (existing ? !!existing.promo : false),

        // persona / UGC
        characterId: body.characterId || (existing && existing.characterId) || null,
        personaUsed: body.personaUsed !== undefined ? !!body.personaUsed : (existing ? !!existing.personaUsed : !!body.characterId),
        audienceBriefUsed: body.audienceBriefUsed !== undefined ? !!body.audienceBriefUsed : (existing ? !!existing.audienceBriefUsed : false),

        // variations & sequence
        multiVariations: body.multiVariations !== undefined ? !!body.multiVariations : (existing ? !!existing.multiVariations : false),
        sequenceId: body.sequenceId || (existing && existing.sequenceId) || null,
        order: Number.isInteger(body.order) ? body.order : (existing ? (existing.order || 0) : 0),

        // video dimension + edit inputs
        engine: str(body.engine, 40) || (existing && existing.engine) || '',
        archetype: str(body.archetype, 60) || (existing && existing.archetype) || '',
        scene: str(body.scene, 800) || (existing && existing.scene) || '',

        // user score (1–10, set in the Library; null = unrated)
        score: body.score !== undefined ? clampScore(body.score) : (existing ? (existing.score ?? null) : null),
        scoredAt: existing ? (existing.scoredAt || null) : null,

        // content bundle (URLs + copy; not filtered on)
        channels: body.channels || (existing && existing.channels) || {},

        // derived (Phase 3)
        perfRollup: existing ? (existing.perfRollup || {}) : {},
      };

      if (!doc.productUrl) return res.status(400).json({ error: 'productUrl is required.' });
      if (!doc.channels || typeof doc.channels !== 'object' || !Object.keys(doc.channels).length) {
        return res.status(400).json({ error: 'channels (the ad content) is required.' });
      }

      await redis('SET', docKey, JSON.stringify(doc));
      await redis('SADD', `idx:creative:owner:${ownerId}`, id);
      if (doc.agencyId) await redis('SADD', `idx:creative:agency:${doc.agencyId}`, id);
      await redis('SADD', `idx:creative:root:${doc.rootId}`, id);
      await Promise.all(tagKeys(ownerId, doc).map(k => redis('SADD', k, id)));

      return res.status(200).json({ creative: toCard(doc), id, updated: !!existing });
    }

    // ── LIST (owner scope; optional faceted filter) — the Library view ─────────
    if (action === 'list') {
      const f = body.filters || {};
      const base = `tag:creative:owner:${ownerId}`;
      const lc = (v) => String(v).toLowerCase();
      const filterKeys = [];
      if (f.domain)   filterKeys.push(`${base}:domain:${lc(f.domain)}`);
      if (f.status)   filterKeys.push(`${base}:status:${lc(f.status)}`);
      if (f.engine)   filterKeys.push(`${base}:engine:${lc(f.engine)}`);
      if (f.vertical) filterKeys.push(`${base}:vertical:${lc(f.vertical)}`);
      if (f.language) filterKeys.push(`${base}:language:${lc(f.language)}`);
      if (f.promo    !== undefined) filterKeys.push(`${base}:promo:${f.promo ? 1 : 0}`);
      if (f.persona  !== undefined) filterKeys.push(`${base}:persona:${f.persona ? 1 : 0}`);

      let ids;
      if (filterKeys.length === 1)    ids = await redis('SMEMBERS', filterKeys[0]);
      else if (filterKeys.length > 1) ids = await redis('SINTER', ...filterKeys);
      else                            ids = await redis('SMEMBERS', `idx:creative:owner:${ownerId}`);
      ids = Array.isArray(ids) ? ids : [];

      const docs = (await Promise.all(ids.slice(0, 500).map(id => redis('GET', `creative:${id}`))))
        .map(r => { try { return JSON.parse(r); } catch (_) { return null; } })
        .filter(Boolean)
        .sort((a, b) => new Date(b.savedAt || b.createdAt) - new Date(a.savedAt || a.createdAt))
        .map(toCard);

      return res.status(200).json({ creatives: docs, count: docs.length });
    }

    // ── GET one (full doc incl. channels — for restore into view-mode) ─────────
    if (action === 'get') {
      if (!body.id) return res.status(400).json({ error: 'id required.' });
      const raw = await redis('GET', `creative:${body.id}`);
      const doc = raw ? JSON.parse(raw) : null;
      if (!doc) return res.status(404).json({ error: 'Not found.' });
      if (doc.ownerId !== ownerId) return res.status(403).json({ error: 'Not your ad.' }); // owner-only for now
      return res.status(200).json({ creative: doc });
    }

    // ── SET SCORE (1–10, or null to clear) — lightweight patch, no re-index ────
    if (action === 'setScore') {
      if (!body.id) return res.status(400).json({ error: 'id required.' });
      const raw = await redis('GET', `creative:${body.id}`);
      const doc = raw ? JSON.parse(raw) : null;
      if (!doc) return res.status(404).json({ error: 'Not found.' });
      if (doc.ownerId !== ownerId) return res.status(403).json({ error: 'Not your ad.' });
      doc.score = clampScore(body.score);
      doc.scoredAt = new Date().toISOString();
      await redis('SET', `creative:${body.id}`, JSON.stringify(doc));
      return res.status(200).json({ id: body.id, score: doc.score });
    }

    // ── DELETE (remove from the library) ───────────────────────────────────────
    if (action === 'delete') {
      if (!body.id) return res.status(400).json({ error: 'id required.' });
      const raw = await redis('GET', `creative:${body.id}`);
      const doc = raw ? JSON.parse(raw) : null;
      if (!doc) return res.status(404).json({ error: 'Not found.' });
      if (doc.ownerId !== ownerId) return res.status(403).json({ error: 'Not your ad.' });

      await redis('SREM', `idx:creative:owner:${ownerId}`, body.id);
      if (doc.agencyId) await redis('SREM', `idx:creative:agency:${doc.agencyId}`, body.id);
      await redis('SREM', `idx:creative:root:${doc.rootId || body.id}`, body.id);
      await Promise.all(tagKeys(ownerId, doc).map(k => redis('SREM', k, body.id)));
      await redis('DEL', `creative:${body.id}`);

      return res.status(200).json({ deleted: body.id });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('creatives error:', err?.message || err);
    return res.status(500).json({ error: String(err?.message || 'Creative store failed').slice(0, 300) });
  }
}
