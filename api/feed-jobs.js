/**
 * /api/feed-jobs — Overnight / scheduled batch-generation JOB STORE (Phase 2, bite 1).
 *
 * The server-side counterpart of the client's runFeedBatchB loop. A job captures a set of feed
 * product snapshots ("picks") to generate while the browser is away — triggered either immediately
 * ("Generate & leave") or at a scheduled time ("overnight"). A worker (bite 2) drains the job one
 * product per invocation, writing each finished ad into /api/creatives as status:'pending_review'.
 *
 * This file is the COMPLETE job API, isolated (sibling of /api/creatives, same Redis + Clerk
 * conventions) so it only ever gets built once:
 *   - User actions (Clerk-auth):   create | list | get | cancel
 *   - Worker actions (secret-auth): itemUpdate | setStatus   ← dormant until bite 2's worker calls them
 *
 * No generation and no queue wiring here yet — create just persists the record; enqueue is bite 3,
 * the schedule dispatcher is bite 5. Testable alone: create a job, list it, get it back.
 *
 * Storage model (mirrors the creatives store):
 *   feedjob:{id}                     → JSON doc (GLOBAL key — id is a UUID)
 *   idx:feedjob:owner:{ownerId}      → set of job ids owned by a user (the jobs list)
 *   (idx:feedjob:due — scheduled-job index — added with the dispatcher in bite 5)
 *
 * Auth:
 *   - Users: x-clerk-session JWT -> payload.sub (same as /api/creatives).
 *   - Worker: x-feed-worker-secret === FEED_WORKER_SECRET (the trusted server-to-server path).
 */

import { randomUUID } from 'node:crypto';

export const config = {
  api: { bodyParser: { sizeLimit: '8mb' } }, // a job carries many product snapshots (picks) at once
};

// ── Upstash Redis helper (REST — same pattern as /api/creatives, /api/characters) ──
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

// Decode Clerk session JWT -> user id (payload.sub), or null. (Same as /api/creatives.)
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
const MAX_PICKS = 200; // guardrail: a single overnight job tops out here

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return ''; }
}

// Normalise one incoming pick into the stored item shape (product payload + progress fields).
// We keep only the fields the worker needs to regenerate the ad — not the entire feed record.
function toItem(p) {
  if (!p || !p.link) return null;
  return {
    link: str(p.link, 1000),
    product: {
      link: str(p.link, 1000),
      title: str(p.title, 300),
      image: str(p.image, 1000),
      description: str(p.description, 4000),
      price: str(p.price, 60),
      productType: str(p.productType, 300),
      brand: str(p.brand, 200),
      availability: str(p.availability, 40),
      onSale: !!p.onSale,
      currency: str(p.currency, 10),
    },
    status: 'pending',   // pending | generating | ready | failed
    creativeId: null,    // set when the worker writes the ad into /api/creatives
    error: null,
  };
}

// Recompute counts + roll the job status up from its items (worker helper).
function rollup(job) {
  const items = job.items || [];
  const done = items.filter(i => i.status === 'ready').length;
  const failed = items.filter(i => i.status === 'failed').length;
  job.counts = { total: items.length, done, failed };
  if (job.status === 'cancelled') return job; // cancelled is terminal — never overwritten by rollup
  const terminal = done + failed;
  if (terminal >= items.length && items.length > 0) {
    job.status = failed >= items.length ? 'failed' : 'done'; // all-failed = failed, otherwise done (counts tell the rest)
  } else if (terminal > 0) {
    job.status = 'running';
  }
  return job;
}

// Light projection for the jobs list — drop the per-item product payloads, keep progress.
function toJobCard(job) {
  return {
    id: job.id,
    status: job.status,
    source: job.source,
    runAt: job.runAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    counts: job.counts,
    options: job.options,
  };
}

async function loadJob(id) {
  const raw = await redis('GET', `feedjob:${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}
async function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  await redis('SET', `feedjob:${job.id}`, JSON.stringify(job));
  return job;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-clerk-session, x-feed-worker-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(503).json({ error: 'Storage temporarily unavailable — please try again shortly.' });
  }

  const body = req.body || {};
  const action = body.action || 'list';

  // Two auth paths: the trusted worker (server-to-server secret) or a signed-in user.
  const workerSecret = req.headers['x-feed-worker-secret'] || '';
  const isWorker = !!process.env.FEED_WORKER_SECRET && workerSecret === process.env.FEED_WORKER_SECRET;
  const ownerId = isWorker ? null : clerkUserId(req);

  const WORKER_ACTIONS = new Set(['itemUpdate', 'setStatus']);
  const USER_ACTIONS = new Set(['create', 'list', 'get', 'cancel']);

  if (WORKER_ACTIONS.has(action)) {
    if (!isWorker) return res.status(401).json({ error: 'Worker auth required.' });
  } else if (USER_ACTIONS.has(action)) {
    if (!ownerId) return res.status(401).json({ error: 'Sign in required.' });
  } else {
    return res.status(400).json({ error: `Unknown action: ${action}` });
  }

  try {
    // ── CREATE (user) — persist a batch job. No enqueue yet (bite 3). ──────────
    if (action === 'create') {
      const picks = Array.isArray(body.picks) ? body.picks.map(toItem).filter(Boolean) : [];
      if (!picks.length) return res.status(400).json({ error: 'picks (products to generate) is required.' });
      if (picks.length > MAX_PICKS) return res.status(400).json({ error: `Too many products — max ${MAX_PICKS} per job.` });

      // runAt: null/absent = run now; a future ISO timestamp = scheduled. Past timestamps collapse to now.
      let runAt = null;
      if (body.runAt) {
        const t = new Date(body.runAt).getTime();
        if (Number.isFinite(t) && t > Date.now()) runAt = new Date(t).toISOString();
      }

      const now = new Date().toISOString();
      const id = `fjob_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const job = {
        id,
        ownerId,
        agencyId: body.agencyId || null,
        status: runAt ? 'scheduled' : 'queued', // queued = ready to enqueue (bite 3); scheduled = waits for its runAt (bite 5)
        source: str(body.source, 300) || domainOf(picks[0] && picks[0].link) || '',
        language: str(body.language, 40) || 'English', // feed locale (de/da/…) → the worker generates copy in it
        runAt,
        options: {
          engine: str(body.engine, 40) || '',                // '' = let generateFromProduct pick as today
          concurrency: body.concurrency === 'parallel' ? 'parallel' : 'sequential', // decision #4: default sequential
        },
        counts: { total: picks.length, done: 0, failed: 0 },
        items: picks,
        error: null,
        createdAt: now,
        updatedAt: now,
      };

      await redis('SET', `feedjob:${id}`, JSON.stringify(job));
      await redis('SADD', `idx:feedjob:owner:${ownerId}`, id);

      return res.status(200).json({ job: toJobCard(job), id });
    }

    // ── LIST (user) — this user's jobs, most recent first ──────────────────────
    if (action === 'list') {
      let ids = await redis('SMEMBERS', `idx:feedjob:owner:${ownerId}`);
      ids = Array.isArray(ids) ? ids : [];
      const jobs = (await Promise.all(ids.slice(0, 200).map(id => redis('GET', `feedjob:${id}`))))
        .map(r => { try { return JSON.parse(r); } catch (_) { return null; } })
        .filter(Boolean)
        .filter(j => j.ownerId === ownerId)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .map(toJobCard);
      return res.status(200).json({ jobs, count: jobs.length });
    }

    // ── GET one (user) — full job incl. items (progress + per-product status) ──
    if (action === 'get') {
      if (!body.id) return res.status(400).json({ error: 'id required.' });
      const job = await loadJob(body.id);
      if (!job) return res.status(404).json({ error: 'Not found.' });
      if (job.ownerId !== ownerId) return res.status(403).json({ error: 'Not your job.' });
      return res.status(200).json({ job });
    }

    // ── CANCEL (user) — mark terminal so the worker skips remaining products ───
    if (action === 'cancel') {
      if (!body.id) return res.status(400).json({ error: 'id required.' });
      const job = await loadJob(body.id);
      if (!job) return res.status(404).json({ error: 'Not found.' });
      if (job.ownerId !== ownerId) return res.status(403).json({ error: 'Not your job.' });
      if (job.status !== 'done' && job.status !== 'failed') job.status = 'cancelled';
      await saveJob(job);
      return res.status(200).json({ job: toJobCard(job) });
    }

    // ── itemUpdate (worker) — set one product's result + roll counts/status up ─
    if (action === 'itemUpdate') {
      if (!body.id || !body.link) return res.status(400).json({ error: 'id and link required.' });
      const job = await loadJob(body.id);
      if (!job) return res.status(404).json({ error: 'Not found.' });
      const item = (job.items || []).find(i => i.link === body.link);
      if (!item) return res.status(404).json({ error: 'Item not in job.' });
      if (body.status && ['pending', 'generating', 'ready', 'failed'].includes(body.status)) item.status = body.status;
      if (body.creativeId !== undefined) item.creativeId = body.creativeId || null;
      if (body.error !== undefined) item.error = body.error ? str(body.error, 500) : null;
      rollup(job);
      await saveJob(job);
      return res.status(200).json({ job: toJobCard(job) });
    }

    // ── setStatus (worker) — explicit job-level transition (e.g. queued->running) ─
    if (action === 'setStatus') {
      if (!body.id || !body.status) return res.status(400).json({ error: 'id and status required.' });
      const allowed = ['scheduled', 'queued', 'running', 'done', 'failed', 'cancelled'];
      if (!allowed.includes(body.status)) return res.status(400).json({ error: 'Bad status.' });
      const job = await loadJob(body.id);
      if (!job) return res.status(404).json({ error: 'Not found.' });
      if (job.status === 'cancelled') return res.status(200).json({ job: toJobCard(job) }); // cancelled stays cancelled
      job.status = body.status;
      await saveJob(job);
      return res.status(200).json({ job: toJobCard(job) });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('feed-jobs error:', err?.message || err);
    return res.status(500).json({ error: String(err?.message || 'Job store failed').slice(0, 300) });
  }
}
