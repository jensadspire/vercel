/**
 * /api/characters — Character Library store (Phase 1: Upstash Redis).
 *
 * Reusable ad characters, owner-scoped (Clerk user) with an optional agencyId
 * parent for later agency-level visibility. Dimensions (source/type/shot/
 * voiceOver/suitableFor) are indexed as Redis sets so faceted filtering is a
 * SINTER — no query engine. Reference images stay as remote CDN URLs for now
 * (Flowbox/Yotpo URLs are stable); Blob-copy hardening comes later.
 *
 * Storage model (see character-library-schema.md):
 *   char:{id}                              → JSON doc (GLOBAL key — id is a UUID,
 *                                            so an agency member's doc is reachable
 *                                            by id alone, without the owner)
 *   idx:char:owner:{ownerId}               → set of ids owned by a user
 *   idx:char:agency:{agencyId}             → set of ids under an agency
 *   tag:char:owner:{ownerId}:{dim}:{value} → set of ids (faceted filter, owner-scoped)
 *
 * Actions (POST body.action): save (create/update) | list | get | delete.
 * Derived fields (videoCount, lastUsedAt, perfRollup) are owned by the creatives
 * hook (Step 3), initialised here.
 *
 * Auth: x-clerk-session JWT decode -> payload.sub (same pattern as /api/runway-recipe).
 */

import { randomUUID } from 'node:crypto';

export const config = {
  api: { bodyParser: { sizeLimit: '2mb' } },
};

// ── Upstash Redis helper (REST — same pattern as /api/scrape, /api/generate) ──
async function redis(command, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null; // not configured
  try {
    const res = await fetch(`${url}/${[command, ...args].map(encodeURIComponent).join('/')}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data.result;
  } catch (_) { return null; }
}

// Decode Clerk session JWT -> user id (payload.sub), or null. (Same as /api/runway-recipe.)
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

// Owner-scoped tag-set keys for a character's dimensions.
function tagKeys(ownerId, c) {
  const keys = [];
  const base = `tag:char:owner:${ownerId}`;
  const add = (dim, val) => {
    if (val === undefined || val === null || val === '') return;
    keys.push(`${base}:${dim}:${String(val).toLowerCase()}`);
  };
  add('source', c.source);
  add('type', c.type);
  add('shot', c.shot);
  add('voiceOver', c.voiceOver ? 1 : 0); // always indexed (0/1) so "has voice-over" filters
  if (Array.isArray(c.suitableFor)) for (const v of c.suitableFor) add('suitableFor', v);
  return keys;
}

const str = (v, n) => (v === undefined || v === null ? '' : String(v)).slice(0, n);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-clerk-session, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth — character library is a signed-in feature (Creative Studio is Pro-gated).
  const ownerId = clerkUserId(req);
  if (!ownerId) return res.status(401).json({ error: 'Sign in required.' });

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(503).json({ error: 'Storage temporarily unavailable — please try again shortly.' });
  }

  const body = req.body || {};
  const action = body.action || 'list';

  try {
    // ── SAVE (create or update) ───────────────────────────────────────────────
    if (action === 'save') {
      const id = body.id || `chr_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const docKey = `char:${id}`;

      // If updating, load the existing doc so we keep createdAt and can clean up
      // its old tag-set memberships before re-indexing.
      let existing = null;
      const existingRaw = await redis('GET', docKey);
      if (existingRaw) { try { existing = JSON.parse(existingRaw); } catch (_) {} }
      if (existing && existing.ownerId !== ownerId) {
        return res.status(403).json({ error: 'Not your character.' });
      }
      if (existing) {
        const oldTags = tagKeys(ownerId, existing);
        await Promise.all(oldTags.map(k => redis('SREM', k, id)));
      }

      const now = new Date().toISOString();
      const refImgs = Array.isArray(body.referenceImages) ? body.referenceImages.slice(0, 10)
                    : (existing && existing.referenceImages) || [];
      const doc = {
        id,
        ownerId,
        agencyId: body.agencyId || (existing && existing.agencyId) || null,
        name:   str(body.name, 120) || str(body.creator, 120) || 'Untitled',
        handle: str(body.handle, 80),
        status: body.status || (existing && existing.status) || 'active',
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,

        // dimensions
        source: body.source || (existing && existing.source) || null,
        type:   body.type   || (existing && existing.type)   || null,
        shot:   body.shot   || (existing && existing.shot)   || 'other',
        voiceOver: typeof body.voiceOver === 'boolean' ? body.voiceOver : (existing ? !!existing.voiceOver : false),
        suitableFor: Array.isArray(body.suitableFor) ? body.suitableFor.slice(0, 12)
                   : (existing && existing.suitableFor) || [],

        // provenance
        originCaption:  str(body.originCaption, 600),
        captionLang:    str(body.captionLang, 10),
        sourceUrl:      str(body.sourceUrl, 500),
        sourceProvider: str(body.sourceProvider, 40),

        // assets (remote CDN URLs for now)
        referenceImages: refImgs,
        seedImageUrl: body.seedImageUrl || (existing && existing.seedImageUrl) || null,
        thumbnailUrl: body.thumbnailUrl || (existing && existing.thumbnailUrl) || null,

        // Seedance (BytePlus) asset reference — links this library character to its authorized asset:// id,
        // so one saved persona can feed many ad-templates. Set after asset-library ingest reaches Active.
        seedanceAssetUri: body.seedanceAssetUri || (existing && existing.seedanceAssetUri) || null,
        seedanceGroupId:  body.seedanceGroupId  || (existing && existing.seedanceGroupId)  || null,

        // derived — managed by the creatives hook (Step 3)
        videoCount: existing ? (existing.videoCount || 0) : 0,
        lastUsedAt: existing ? (existing.lastUsedAt || null) : null,
        perfRollup: existing ? (existing.perfRollup || {}) : {},
      };

      if (!doc.source) return res.status(400).json({ error: 'source is required.' });
      if (!doc.seedImageUrl && !doc.thumbnailUrl && doc.referenceImages.length === 0) {
        return res.status(400).json({ error: 'at least one image is required.' });
      }

      await redis('SET', docKey, JSON.stringify(doc));
      await redis('SADD', `idx:char:owner:${ownerId}`, id);
      if (doc.agencyId) await redis('SADD', `idx:char:agency:${doc.agencyId}`, id);
      await Promise.all(tagKeys(ownerId, doc).map(k => redis('SADD', k, id)));

      return res.status(200).json({ character: doc, updated: !!existing });
    }

    // ── LIST (owner scope; optional faceted filter) ───────────────────────────
    if (action === 'list') {
      const f = body.filters || {};
      const base = `tag:char:owner:${ownerId}`;
      const filterKeys = [];
      if (f.source)   filterKeys.push(`${base}:source:${String(f.source).toLowerCase()}`);
      if (f.type)     filterKeys.push(`${base}:type:${String(f.type).toLowerCase()}`);
      if (f.shot)     filterKeys.push(`${base}:shot:${String(f.shot).toLowerCase()}`);
      if (f.voiceOver !== undefined) filterKeys.push(`${base}:voiceOver:${f.voiceOver ? 1 : 0}`);
      if (f.suitableFor) filterKeys.push(`${base}:suitableFor:${String(f.suitableFor).toLowerCase()}`);

      let ids;
      if (filterKeys.length === 1)      ids = await redis('SMEMBERS', filterKeys[0]);
      else if (filterKeys.length > 1)   ids = await redis('SINTER', ...filterKeys);
      else                              ids = await redis('SMEMBERS', `idx:char:owner:${ownerId}`);
      ids = Array.isArray(ids) ? ids : [];

      const docs = (await Promise.all(ids.slice(0, 300).map(id => redis('GET', `char:${id}`))))
        .map(r => { try { return JSON.parse(r); } catch (_) { return null; } })
        .filter(Boolean)
        .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

      return res.status(200).json({ characters: docs, count: docs.length });
    }

    // ── GET one ───────────────────────────────────────────────────────────────
    if (action === 'get') {
      if (!body.id) return res.status(400).json({ error: 'id required.' });
      const raw = await redis('GET', `char:${body.id}`);
      const doc = raw ? JSON.parse(raw) : null;
      if (!doc) return res.status(404).json({ error: 'Not found.' });
      // Owner-only for now; agency-visibility read switches on when agency
      // membership is resolvable from the session.
      if (doc.ownerId !== ownerId) return res.status(403).json({ error: 'Not your character.' });
      return res.status(200).json({ character: doc });
    }

    // ── DELETE ────────────────────────────────────────────────────────────────
    if (action === 'delete') {
      if (!body.id) return res.status(400).json({ error: 'id required.' });
      const raw = await redis('GET', `char:${body.id}`);
      const doc = raw ? JSON.parse(raw) : null;
      if (!doc) return res.status(404).json({ error: 'Not found.' });
      if (doc.ownerId !== ownerId) return res.status(403).json({ error: 'Not your character.' });

      await redis('SREM', `idx:char:owner:${ownerId}`, body.id);
      if (doc.agencyId) await redis('SREM', `idx:char:agency:${doc.agencyId}`, body.id);
      await Promise.all(tagKeys(ownerId, doc).map(k => redis('SREM', k, body.id)));
      await redis('DEL', `char:${body.id}`);

      return res.status(200).json({ deleted: body.id });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('characters error:', err?.message || err);
    return res.status(500).json({ error: String(err?.message || 'Character store failed').slice(0, 300) });
  }
}
