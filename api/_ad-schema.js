// api/_ad-schema.js
// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for ad CLASSIFICATION + PERFORMANCE metadata.
//
// Both stores (ad-templates.js for sequences, creatives.js for the vault) and the
// App.jsx UI reference these shapes, so the objective enum and the performance slot
// are defined ONCE here and imported — no drift between sequence clips and library ads.
//
// Three things live on every ad/clip/template record, all additive and backward-safe:
//   • objective   — one funnel stage (enum). Drives flow layout + objective filtering.
//   • promo       — a boolean modifier (a sale can be awareness OR conversion), kept
//                   separate from the funnel stage on purpose.
//   • tags[]      — open list for extra dimensions you'll add later (free clustering).
//   • performance — a nullable, platform-agnostic metrics slot. Stays empty until the
//                   read-API lands; then it's populated with zero reshape.
//
// Underscore-prefixed → Vercel does NOT treat this as an endpoint (it is imported).
// Self-contained, no deps. Slim by design: only unified, cross-platform metrics.
// ─────────────────────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1;

// ── Objectives — the funnel, in order (left→right in the flow view) ──────────
export const OBJECTIVES = [
  { id: 'awareness',   label: 'Awareness',   order: 1, hint: 'Introduce the brand / product to new audiences' },
  { id: 'engagement',  label: 'Engagement',  order: 2, hint: 'Drive views, interaction, consideration' },
  { id: 'retargeting', label: 'Retargeting', order: 3, hint: 'Re-engage people who already interacted' },
  { id: 'conversion',  label: 'Conversion',  order: 4, hint: 'Drive the purchase / sign-up / action' },
];
export const OBJECTIVE_IDS = OBJECTIVES.map(o => o.id);
export const DEFAULT_OBJECTIVE = 'awareness';

export function objectiveMeta(id) {
  return OBJECTIVES.find(o => o.id === id) || null;
}
export function objectiveOrder(id) {
  const m = objectiveMeta(id);
  return m ? m.order : 99;
}

// ── Auto-suggest an objective from a shot's role / position in a sequence ────
// role takes precedence; position is the fallback. Always user-overridable.
const ROLE_OBJECTIVE = {
  hook: 'awareness', intro: 'awareness', teaser: 'awareness', opener: 'awareness',
  problem: 'engagement', story: 'engagement', feature: 'engagement',
  demo: 'engagement', product: 'engagement', ugc: 'engagement', lifestyle: 'engagement',
  proof: 'retargeting', review: 'retargeting', testimonial: 'retargeting',
  reminder: 'retargeting', comparison: 'retargeting', objection: 'retargeting',
  offer: 'conversion', cta: 'conversion', sale: 'conversion', checkout: 'conversion', closer: 'conversion',
};

export function suggestObjective(ctx = {}) {
  const role = String(ctx.role || '').toLowerCase().trim();
  if (role && ROLE_OBJECTIVE[role]) return ROLE_OBJECTIVE[role];

  const total = Number.isFinite(ctx.total) ? ctx.total : 0;
  const index = Number.isFinite(ctx.index) ? ctx.index : 0;
  if (total <= 1) return 'awareness';
  if (index <= 0) return 'awareness';
  if (index >= total - 1) return 'conversion';
  if (total >= 4 && index === total - 2) return 'retargeting';
  return 'engagement';
}

// ── Performance slot — platform-agnostic, nullable, unified across channels ──
export function emptyPerformance() {
  return {
    status: 'none',        // none | pending | synced
    platform: null,        // 'google' | 'meta' | 'tiktok' | …
    campaignId: null,
    adId: null,
    impressions: null,
    clicks: null,
    ctr: null,             // clicks / impressions
    spend: null,
    currency: null,
    conversions: null,
    conversionValue: null,
    roas: null,            // conversionValue / spend
    lastSyncedAt: null,    // ISO string when populated
  };
}

const PERF_NUM_KEYS = ['impressions', 'clicks', 'ctr', 'spend', 'conversions', 'conversionValue', 'roas'];
const PERF_STR_KEYS = ['platform', 'campaignId', 'adId', 'currency', 'lastSyncedAt'];

export function normalizePerformance(input) {
  const base = emptyPerformance();
  if (!input || typeof input !== 'object') return base;
  for (const k of PERF_NUM_KEYS) {
    const v = input[k];
    if (v != null && v !== '' && Number.isFinite(Number(v))) base[k] = Number(v);
  }
  for (const k of PERF_STR_KEYS) {
    const v = input[k];
    if (v != null && v !== '') base[k] = String(v);
  }
  const st = String(input.status || '').toLowerCase();
  base.status = (st === 'pending' || st === 'synced') ? st
    : (base.impressions != null || base.clicks != null || base.spend != null) ? 'synced' : 'none';
  return base;
}

// ── Tags — open clustering dimension ─────────────────────────────────────────
const TAG_MAX = 24;
export function normalizeTags(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const t of input) {
    const s = String(t == null ? '' : t).trim().toLowerCase().slice(0, 40);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= TAG_MAX) break;
  }
  return out;
}

// ── The one call the stores use: coerce the four fields onto any record ──────
// ctx.suggest = { role, index, total } supplies an auto-objective when none is set.
export function normalizeAdMeta(input = {}, ctx = {}) {
  const src = (input && typeof input === 'object') ? input : {};

  let objective = String(src.objective || '').toLowerCase().trim();
  if (!OBJECTIVE_IDS.includes(objective)) {
    // Sequence clips (with a shot role/position) get a sensible auto-stage; everything
    // else stays null = unclassified, so the UI can prompt rather than invent a stage.
    objective = ctx.suggest ? suggestObjective(ctx.suggest) : null;
  }

  return {
    objective,
    promo: !!src.promo,
    tags: normalizeTags(src.tags),
    performance: normalizePerformance(src.performance),
  };
}
