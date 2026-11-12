/**
 * /api/ad-templates — Ad Template / boilerplate store (Upstash Redis).
 *
 * A template is the stored "formula" of a persona ad so it can be re-run or remixed: the persona reference
 * (asset:// id and/or a Character Library id), the prompt, any garment/product reference images, and the
 * render settings (ratio, duration, engine, model). "Make another ad with the same character" = read a
 * template, tweak a field, fire it at /api/seedance-byteplus. This store is pure persistence (save/list/
 * get/delete) — generation stays in the engine endpoints, same separation as /api/characters.
 *
 * Owner-scoped (Clerk user), mirroring /api/characters exactly (REST Redis helper, JWT decode, owner sets).
 * Isolated new file — touches nothing existing.
 *
 * Storage model:
 *   tpl:{id}                  → JSON doc (global key; id is a UUID)
 *   idx:tpl:owner:{ownerId}   → set of ids owned by a user
 *
 * Actions (POST body.action): save (create/update) | list | get | delete.
 * Auth: x-clerk-session JWT decode -> payload.sub (same pattern as /api/characters, /api/runway-recipe).
 */

import { randomUUID } from 'node:crypto';
import { normalizeAdMeta, suggestObjective, OBJECTIVE_IDS } from './_ad-schema.js';
import { scopeFromReq } from './lib/scope.js';

export const config = {
  api: { bodyParser: { sizeLimit: '2mb' } },
};

// ── Upstash Redis helper (REST — same pattern as /api/characters, /api/generate) ──
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-clerk-session, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth — templates are a signed-in feature (Creative Studio is Pro-gated).
  const { userId: ownerId, scope } = scopeFromReq(req);
  if (!ownerId) return res.status(401).json({ error: 'Sign in required.' });

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(503).json({ error: 'Storage temporarily unavailable — please try again shortly.' });
  }

  const body = req.body || {};
  const action = body.action || 'list';

  try {
    // ── SAVE (create or update) ───────────────────────────────────────────────
    if (action === 'save') {
      const id = body.id || `tpl_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const docKey = `tpl:${id}`;

      // If updating, load existing to preserve createdAt and verify ownership.
      let existing = null;
      const existingRaw = await redis('GET', docKey);
      if (existingRaw) { try { existing = JSON.parse(existingRaw); } catch (_) {} }
      if (existing && (existing.scope || existing.ownerId) !== scope) {
        return res.status(403).json({ error: 'Not your template.' });
      }

      const now = new Date().toISOString();
      const garments = Array.isArray(body.garmentUrls) ? body.garmentUrls.slice(0, 9)
                     : (existing && existing.garmentUrls) || [];
      const shotsArr = Array.isArray(body.shots) ? body.shots.slice(0, 8).map(function (s) { return String(s).slice(0, 5000); }) : ((existing && existing.shots) || []);
      // Per-shot funnel stage (parallel to shots[]) — drives the sequence flow view.
      // Uses an explicitly provided stage when valid, else auto-suggests from position.
      const providedObj = Array.isArray(body.shotObjectives) ? body.shotObjectives : ((existing && existing.shotObjectives) || []);
      const shotObjectives = shotsArr.map(function (_s, i) {
        const given = String(providedObj[i] || '').toLowerCase().trim();
        return OBJECTIVE_IDS.includes(given) ? given : suggestObjective({ index: i, total: shotsArr.length });
      });
      // Template-level classification + nullable performance slot (shared _ad-schema.js).
      const tplMeta = normalizeAdMeta({
        objective:   body.objective   !== undefined ? body.objective   : (existing && existing.objective),
        promo:       body.promo       !== undefined ? body.promo       : (existing && existing.promo),
        tags:        body.tags        !== undefined ? body.tags        : (existing && existing.tags),
        performance: body.performance !== undefined ? body.performance : (existing && existing.performance),
      });
      const doc = {
        id,
        ownerId,
        scope: existing ? (existing.scope || scope) : scope,
        name: str(body.name, 120) || (existing && existing.name) || 'Untitled template',
        status: body.status || (existing && existing.status) || 'active',
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now,

        // persona reference — asset:// for the engine, and/or a Character Library id for linkage
        assetUri:    body.assetUri    || (existing && existing.assetUri)    || null,
        characterId: body.characterId || (existing && existing.characterId) || null,

        // the ad formula
        prompt:  str(body.prompt, 5000) || (existing && existing.prompt) || '',
        garmentUrls: garments,
        shots: shotsArr,
        shotObjectives,
        ratio:    body.ratio    || (existing && existing.ratio)    || '9:16',
        duration: Number.isFinite(body.duration) ? body.duration : (existing ? existing.duration : 5),
        engine:   body.engine   || (existing && existing.engine)   || 'seedance-byteplus',
        model:    body.model    || (existing && existing.model)    || null, // e.g. a specific Seedance model id

        // display helpers
        thumbnailUrl: body.thumbnailUrl || (existing && existing.thumbnailUrl) || null,
        lastVideoUrl: body.lastVideoUrl || (existing && existing.lastVideoUrl) || null,
        landingUrl: str(body.landingUrl, 2000) || (existing && existing.landingUrl) || null, // real product-page landing (click destination) — separate from garmentUrls (images)
        origin: (body.origin && typeof body.origin === 'object') ? body.origin : ((existing && existing.origin) || null), // full origin snapshot (Google+Meta+landing) for view-mode recovery; stripped from the list projection

        // classification + performance (shared _ad-schema.js). objective is null until set;
        // performance is empty until the read-API lands, then a per-objective rollup of this
        // template's generated ads — populated with no reshape.
        objective: tplMeta.objective,
        promo: tplMeta.promo,
        tags: tplMeta.tags,
        performance: tplMeta.performance,
      };

      if (!doc.assetUri && !doc.characterId) {
        return res.status(400).json({ error: 'assetUri or characterId is required.' });
      }
      if (!doc.prompt) return res.status(400).json({ error: 'prompt is required.' });

      await redis('SET', docKey, JSON.stringify(doc));
      await redis('SADD', `idx:tpl:owner:${scope}`, id);

      return res.status(200).json({ template: doc, updated: !!existing });
    }

    // ── LIST (owner scope) ────────────────────────────────────────────────────
    if (action === 'list') {
      let ids = await redis('SMEMBERS', `idx:tpl:owner:${scope}`);
      ids = Array.isArray(ids) ? ids : [];
      const docs = (await Promise.all(ids.slice(0, 300).map(id => redis('GET', `tpl:${id}`))))
        .map(r => { try { return JSON.parse(r); } catch (_) { return null; } })
        .filter(Boolean)
        .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
      const light = docs.map(function (d) { const c = Object.assign({}, d); delete c.origin; return c; }); // origin is heavy — returned only by GET
      return res.status(200).json({ templates: light, count: light.length });
    }

    // ── GET one ───────────────────────────────────────────────────────────────
    if (action === 'get') {
      if (!body.id) return res.status(400).json({ error: 'id required.' });
      const raw = await redis('GET', `tpl:${body.id}`);
      const doc = raw ? JSON.parse(raw) : null;
      if (!doc) return res.status(404).json({ error: 'Not found.' });
      if ((doc.scope || doc.ownerId) !== scope) return res.status(403).json({ error: 'Not your template.' });
      return res.status(200).json({ template: doc });
    }

    // ── DELETE ────────────────────────────────────────────────────────────────
    if (action === 'delete') {
      if (!body.id) return res.status(400).json({ error: 'id required.' });
      const raw = await redis('GET', `tpl:${body.id}`);
      const doc = raw ? JSON.parse(raw) : null;
      if (!doc) return res.status(404).json({ error: 'Not found.' });
      if ((doc.scope || doc.ownerId) !== scope) return res.status(403).json({ error: 'Not your template.' });

      await redis('SREM', `idx:tpl:owner:${scope}`, body.id);
      await redis('DEL', `tpl:${body.id}`);
      return res.status(200).json({ deleted: body.id });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('ad-templates error:', err?.message || err);
    return res.status(500).json({ error: String(err?.message || 'Template store failed').slice(0, 300) });
  }
}
