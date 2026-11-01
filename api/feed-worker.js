/**
 * /api/feed-worker — Overnight batch WORKER (Phase 2, bite 2).
 *
 * The server-side re-expression of App.jsx's generateFromProduct, run with no browser. Drives a job
 * created by /api/feed-jobs, one product at a time, writing each finished ad into /api/creatives with
 * status:'pending_review'. Because the video render poll is minutes long (far past any single
 * serverless invocation), the per-product pipeline is split into two phases chained by QStash delays,
 * so every invocation stays seconds long and fits any Vercel plan:
 *
 *   phase 'a'  → RSA + Meta + engine-route + scene + storyboard, then KICK the video render.
 *                Stashes the partial result and schedules phase 'b'.
 *   phase 'b'  → poll the render ONCE. Ready → finalise channels, save the creative, mark the item,
 *                and enqueue the NEXT product's phase 'a' (sequential — decision #4). Still rendering
 *                → reschedule 'b'. Failed/timed-out → save the ad without video (as the client does
 *                when a render fails) and move on.
 *
 * Auth — two paths:
 *   - start (Clerk user): kicks a job's chain (the "Generate & leave" trigger). Owner-checked.
 *   - a / b (worker secret): internal phases, delivered by QStash with x-feed-worker-secret forwarded.
 *
 * Env: QSTASH_TOKEN, FEED_WORKER_SECRET, ADMIN_KEY (existing — RSA admin bypass),
 *      UPSTASH_REDIS_REST_URL/_TOKEN (existing), and a public base URL (VERCEL_URL is auto-set;
 *      PUBLIC_BASE_URL overrides). QStash must be able to reach this deployment publicly (turn off
 *      Vercel Deployment Protection on the preview, or allowlist QStash).
 *
 * Isolated: new file. The only merged-code touch is creatives.js's trusted-write branch (bite 2a).
 */

export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };

const WORKER_SECRET = process.env.FEED_WORKER_SECRET || '';
const BASE = process.env.PUBLIC_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
const QSTASH_URL = (process.env.QSTASH_URL || 'https://qstash.upstash.io').replace(/\/+$/, '');

const FIRST_POLL_DELAY = 60;   // s before the first render poll (most renders need ≥1 min)
const POLL_INTERVAL    = 15;   // s between subsequent polls
const MAX_POLLS        = 44;   // 60 + 44×15 ≈ 11 min cap (matches the client's ~12 min ceiling)

// ── Upstash Redis (REST — same pattern as the other endpoints) ──
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

async function loadJob(id) {
  const raw = await redis('GET', `feedjob:${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// Mutate a job item's progress through feed-jobs (reuses its rollup — single source of truth).
async function itemUpdate(jobId, link, patch) {
  try {
    await fetch(`${BASE}/api/feed-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-feed-worker-secret': WORKER_SECRET },
      body: JSON.stringify({ action: 'itemUpdate', id: jobId, link, ...patch }),
    });
  } catch (_) {}
}

// Schedule a delayed call to ourselves via QStash (the chain's clock).
async function enqueue(phase, payload, delaySeconds, notBefore) {
  const token = process.env.QSTASH_TOKEN;
  if (!token || !BASE) throw new Error('QStash/base URL not configured');
  const dest = `${BASE}/api/feed-worker`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Upstash-Method': 'POST',
    'Upstash-Forward-x-feed-worker-secret': WORKER_SECRET,
  };
  if (notBefore && notBefore > 0) headers['Upstash-Not-Before'] = String(Math.floor(notBefore));
  else if (delaySeconds > 0) headers['Upstash-Delay'] = `${Math.round(delaySeconds)}s`;
  const res = await fetch(`${QSTASH_URL}/v2/publish/${dest}`, {
    method: 'POST', headers, body: JSON.stringify({ phase, ...payload }),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`QStash ${res.status} ${t.slice(0, 160)}`); }
  return res.json().catch(() => ({}));
}

// ── Per-step pipeline helpers (faithful to generateFromProduct) ──

async function genRSA(product, language) {
  const link = product.link || '', title = product.title || '', description = product.description || '';
  const prompt = "You are a Google Ads expert. Generate RSA ad copy.\nCURRENT YEAR: " + new Date().getFullYear()
    + "\nURL: " + link + "\nPRODUCT: " + title + "\nPRODUCT DESCRIPTION: " + description
    + "\nBRAND: " + (product.brand || '') + "\nCATEGORY: " + (product.productType || '')
    + "\nOUTPUT LANGUAGE: " + language + "\nCRITICAL: Write ALL copy in " + language
    + ".\n\nReturn ONLY valid JSON, no markdown:\n{\n  \"campaign\": \"name\",\n  \"adGroup\": \"name\",\n  \"headlines\": [\"h1\", 15 total],\n  \"descriptions\": [\"d1\",\"d2\",\"d3\",\"d4\"],\n  \"path1\": \"p1\",\n  \"path2\": \"p2\"\n}\nRules: Headlines max 30 chars each, exactly 15, unique. Descriptions 80-90 chars each, exactly 4, complete sentences ending with punctuation. path1/path2 max 15 chars.";
  try {
    const r = await fetch(`${BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': process.env.ADMIN_KEY || '' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await r.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const m = text.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
    if (!m) return null;
    const pr = JSON.parse(m[0]);
    return {
      campaign: pr.campaign || '', adGroup: pr.adGroup || '',
      headlines: (pr.headlines || []).slice(0, 15).map(h => String(h || '').slice(0, 30)).filter(Boolean),
      descriptions: (pr.descriptions || []).slice(0, 4).map(d => String(d || '').trim()).filter(Boolean),
      path1: (pr.path1 || '').slice(0, 15), path2: (pr.path2 || '').slice(0, 15),
      finalUrl: link,
    };
  } catch (_) { return null; }
}

async function genMeta(product, language) {
  const link = product.link || '', title = product.title || '', description = product.description || '';
  const images = Array.isArray(product.images) ? product.images : (product.image ? [product.image] : []);
  try {
    const r = await fetch(`${BASE}/api/generate-meta-feed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product: { link, title, description, images, image: product.image, brand: product.brand, productType: product.productType }, language }),
    });
    const d = await r.json();
    if (!d || !(d.primaryTexts || d.headlines)) return null;
    const initialImageUrl = d.heroProductImage || d.imageUrl || null;
    const imageVariations = [d.heroProductImage, ...(d.allImages || []), d.secondaryImage, d.tertiaryImage]
      .filter(Boolean).filter((img, i, arr) => arr.indexOf(img) === i).slice(0, 16);
    const hlV = d.headlines || [], dV = d.descriptions || [];
    const carouselCardTexts = Array.from({ length: 5 }, (_, i) => ({ headline: hlV[i] || hlV[i % Math.max(hlV.length, 1)] || '', desc: dV[i % Math.max(dV.length, 1)] || '' }));
    return {
      meta: {
        primaryTexts: d.primaryTexts || [], headlines: d.headlines || [], descriptions: d.descriptions || [],
        imageUrl: (initialImageUrl || '').replace(/^http:/, 'https:'), imageVariations, carouselCardTexts,
      },
      heroProductImage: d.heroProductImage || null,
    };
  } catch (_) { return null; }
}

// Client-side filename heuristic (detectVideoEngine), replicated verbatim.
function detectVideoEngine(imgUrl) {
  if (!imgUrl) return 'kling';
  const url = String(imgUrl).toLowerCase();
  const modelSignals = /model|lifestyle|worn|lookbook|campaign|editorial|fashion|outfit|wear|style|portrait|cashmere|silk|linen|kleid|kjole|blazer|jacket|jakke/i;
  const fashionDomains = /nordicweaving|boozt|stylepit|ellos|miinto|kaufmann|magasin|illum|zalando|asos|hm[.]|zara/i;
  const dim = url.match(/(\d+)x(\d+)/);
  if (dim) { const w = parseInt(dim[1]), h = parseInt(dim[2]); if (h > w * 1.3) return 'runway'; }
  if (modelSignals.test(url) || fashionDomains.test(url)) return 'runway';
  return 'kling';
}

async function routeEngine(heroImg) {
  if (detectVideoEngine(heroImg) === 'runway') return 'runway';
  if (heroImg) {
    try {
      const r = await fetch(`${BASE}/api/detect-bg`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageUrl: heroImg }) });
      const bg = await r.json();
      if (bg && bg.bgEngine === 'runway') return 'runway';
    } catch (_) {}
  }
  return 'kling';
}

async function pickScene(product) {
  try {
    const r = await fetch(`${BASE}/api/pick-scene`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product: { title: product.title || '', description: product.description || '', productType: product.productType || '', brand: product.brand || '' } }),
    });
    const d = await r.json();
    if (d && d.ok) return { scene: d.scene || null, vertical: d.vertical || '' };
  } catch (_) {}
  return { scene: null, vertical: '' };
}

async function genStoryboard(link, language, engine, scene, product) {
  try {
    const r = await fetch(`${BASE}/api/generate-tiktok`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: link, language, videoEngine: engine, archetype: 'scene_reveal', scene: scene || undefined, pageContent: ((product.title || '') + '\n' + (product.description || '')), productDescription: product.description || '' }),
    });
    const d = await r.json();
    if (d && !d.error) return d;
  } catch (_) {}
  return null;
}

const apiForEngine = (e) => e === 'runway' ? '/api/runway' : '/api/kling';
const backupEngine = (e) => e === 'kling' ? 'runway' : 'kling';

// Kick the render (one infra failover) — DO NOT poll here. Returns {videoUrl}|{poll}|{error}.
async function kickVideo({ engine, imageUrl, storyboard, videoPrompt, language, logoUrl, brand }) {
  if (!imageUrl || !videoPrompt) return { error: 'missing image or prompt' };
  const img = String(imageUrl).replace(/^http:\/\//, 'https://').replace(/^\/\//, 'https://');
  const body = { imageUrl: img, storyboard: storyboard || [], prompt: videoPrompt, language: language || 'English', brand: brand || '', logoUrl: logoUrl || null, overlayIntro: '', overlayOutro: '', matchAspect: true };
  const createOn = async (e) => {
    try {
      const rr = await fetch(`${BASE}${apiForEngine(e)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!rr.ok && rr.status >= 500) return { infraFail: true, d: { error: 'HTTP ' + rr.status } };
      const d = await rr.json().catch(() => ({}));
      return { infraFail: false, d };
    } catch (netErr) { return { infraFail: true, d: { error: netErr.message } }; }
  };
  let used = engine === 'runway' ? 'runway' : 'kling';
  let a = await createOn(used);
  if (a.infraFail) { used = backupEngine(used); a = await createOn(used); }
  const d = (a && a.d) || {};
  if (d.gated) return { error: 'gated' };
  if (a.infraFail || d.error || (!d.videoUrl && !d.requestId && !d.taskId)) return { error: (d && d.error) || 'video create failed' };
  if (d.videoUrl) return { videoUrl: d.videoUrl, engine: used };
  return { poll: { api: apiForEngine(used), pollId: d.requestId || d.taskId, pollKey: d.taskId ? 'taskId' : 'requestId', engine: used } };
}

// Poll the render ONCE. Returns {videoUrl}|{pending}|{error}.
async function pollOnce({ api, pollId, pollKey }) {
  try {
    const pr = await fetch(`${BASE}${api}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'poll', [pollKey]: pollId }) });
    const pd = await pr.json();
    if (pd.videoUrl) return { videoUrl: pd.videoUrl };
    if (pd.status === 'FAILED' || pd.status === 'CANCELLED') return { error: 'render ' + pd.status };
    return { pending: true };
  } catch (_) { return { pending: true }; } // transient — treat as still rendering
}

// Build the creatives payload and save it as a pending-review ad owned by the job's owner.
async function saveCreative(job, work, videoUrl) {
  const channels = {
    google: work.google || null,
    meta: work.meta || null,
    video: videoUrl ? { url: videoUrl, storyboard: work.storyboard || [], videoPrompt: work.videoPrompt || '' } : null,
  };
  const payload = {
    action: 'save', inputSource: 'feed', ownerId: job.ownerId,
    status: 'pending_review',
    productUrl: work.url, productTitle: work.title || '',
    engine: work.engine || '', archetype: 'scene_reveal', scene: work.scene || '',
    vertical: work.vertical || '', language: work.language || 'English', promo: !!work.promo,
    channels,
  };
  const r = await fetch(`${BASE}/api/creatives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-feed-worker-secret': WORKER_SECRET },
    body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  if (r.ok && d.id) return d.id;
  throw new Error((d && d.error) || ('creatives save failed ' + r.status));
}

// Move to the next product (sequential), or leave the job to roll up to done.
async function chainNext(jobId, nextIndex, total) {
  if (nextIndex < total) await enqueue('a', { jobId, index: nextIndex }, 1);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-clerk-session, x-feed-worker-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const phase = body.phase || 'start';

  const isWorker = !!WORKER_SECRET && (req.headers['x-feed-worker-secret'] || '') === WORKER_SECRET;

  try {
    // ── START (user) — kick a job's chain from the first product ──────────────
    if (phase === 'start') {
      const ownerId = clerkUserId(req);
      if (!ownerId) return res.status(401).json({ error: 'Sign in required.' });
      const job = await loadJob(body.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found.' });
      if (job.ownerId !== ownerId) return res.status(403).json({ error: 'Not your job.' });
      if (job.status === 'cancelled' || job.status === 'done') return res.status(200).json({ ok: true, status: job.status });
      if (!process.env.QSTASH_TOKEN || !BASE) return res.status(503).json({ error: 'Batch worker not configured (QStash / base URL).' });
      let notBefore = 0;
      if (job.runAt) { const t = new Date(job.runAt).getTime(); if (Number.isFinite(t) && t > Date.now() + 5000) notBefore = Math.floor(t / 1000); }
      await enqueue('a', { jobId: job.id, index: 0 }, 0, notBefore);
      return res.status(200).json({ ok: true, started: job.id, total: (job.items || []).length, scheduledFor: notBefore ? job.runAt : null });
    }

    // Internal phases require the worker secret.
    if (!isWorker) return res.status(401).json({ error: 'Worker auth required.' });

    const jobId = body.jobId;
    const index = Number.isInteger(body.index) ? body.index : 0;
    const job = await loadJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (job.status === 'cancelled') return res.status(200).json({ ok: true, cancelled: true });
    const items = job.items || [];
    if (index >= items.length) return res.status(200).json({ ok: true, done: true });
    const item = items[index];
    if (!item || !item.product) { await chainNext(jobId, index + 1, items.length); return res.status(200).json({ ok: true, skipped: index }); }
    const product = item.product;
    const language = job.language || 'English';

    // ── PHASE A — generate copy + kick the render ─────────────────────────────
    if (phase === 'a') {
      await itemUpdate(jobId, item.link, { status: 'generating' });

      const [google, metaOut, scenePick] = await Promise.all([
        genRSA(product, language),
        genMeta(product, language),
        pickScene(product),
      ]);
      const heroImg = (Array.isArray(product.images) && product.images[0]) || product.image || (metaOut && metaOut.heroProductImage) || null;
      const engine = await routeEngine(heroImg);
      const storyboard = await genStoryboard(product.link, language, engine, scenePick.scene, product);

      const work = {
        url: product.link, title: product.title || '',
        google: google || null,
        meta: (metaOut && metaOut.meta) || null,
        storyboard: (storyboard && storyboard.storyboard) || [],
        videoPrompt: (storyboard && storyboard.videoPrompt) || '',
        engine, scene: scenePick.scene || '', vertical: scenePick.vertical || '',
        language, promo: !!product.onSale,
        brand: (storyboard && storyboard.brand) || product.brand || '',
      };

      // Kick the render (if we have the inputs); otherwise finalise copy-only now.
      let kick = { error: 'no storyboard' };
      if (work.videoPrompt && heroImg) {
        const favicon = (() => { try { return 'https://www.google.com/s2/favicons?domain=' + new URL(product.link).hostname + '&sz=128'; } catch (_) { return null; } })();
        kick = await kickVideo({ engine, imageUrl: heroImg, storyboard: work.storyboard, videoPrompt: work.videoPrompt, language, logoUrl: favicon, brand: work.brand });
      }

      if (kick.videoUrl) {                       // instant render — finalise immediately
        try { const id = await saveCreative(job, work, kick.videoUrl); await itemUpdate(jobId, item.link, { status: 'ready', creativeId: id }); }
        catch (e) { await itemUpdate(jobId, item.link, { status: 'failed', error: e.message }); }
        await chainNext(jobId, index + 1, items.length);
        return res.status(200).json({ ok: true, index, instant: true });
      }
      if (kick.poll) {                           // render running — stash + schedule poll
        await redis('SET', `feedjobwork:${jobId}:${index}`, JSON.stringify({ work, render: kick.poll }), 'EX', 3600);
        await enqueue('b', { jobId, index, attempt: 0 }, FIRST_POLL_DELAY);
        return res.status(200).json({ ok: true, index, rendering: true });
      }
      // Render couldn't start — save the ad without video (matches client's render-fail behaviour).
      try { const id = await saveCreative(job, work, null); await itemUpdate(jobId, item.link, { status: 'ready', creativeId: id, error: 'video: ' + (kick.error || 'skipped') }); }
      catch (e) { await itemUpdate(jobId, item.link, { status: 'failed', error: e.message }); }
      await chainNext(jobId, index + 1, items.length);
      return res.status(200).json({ ok: true, index, novideo: true });
    }

    // ── PHASE B — poll the render once; finalise or reschedule ────────────────
    if (phase === 'b') {
      const attempt = Number.isInteger(body.attempt) ? body.attempt : 0;
      const raw = await redis('GET', `feedjobwork:${jobId}:${index}`);
      let stash = null; try { stash = raw ? JSON.parse(raw) : null; } catch (_) {}
      if (!stash || !stash.render) { // lost work blob — fail the item and move on
        await itemUpdate(jobId, item.link, { status: 'failed', error: 'render context lost' });
        await chainNext(jobId, index + 1, items.length);
        return res.status(200).json({ ok: true, index, lost: true });
      }

      const poll = await pollOnce(stash.render);
      if (poll.videoUrl) {
        try { const id = await saveCreative(job, stash.work, poll.videoUrl); await itemUpdate(jobId, item.link, { status: 'ready', creativeId: id }); }
        catch (e) { await itemUpdate(jobId, item.link, { status: 'failed', error: e.message }); }
        await redis('DEL', `feedjobwork:${jobId}:${index}`);
        await chainNext(jobId, index + 1, items.length);
        return res.status(200).json({ ok: true, index, ready: true });
      }
      if (poll.pending && attempt < MAX_POLLS) {  // still rendering — poll again later
        await enqueue('b', { jobId, index, attempt: attempt + 1 }, POLL_INTERVAL);
        return res.status(200).json({ ok: true, index, pending: true, attempt });
      }
      // Failed or timed out — save the ad without video, move on.
      try { const id = await saveCreative(job, stash.work, null); await itemUpdate(jobId, item.link, { status: 'ready', creativeId: id, error: 'video: ' + (poll.error || 'timeout') }); }
      catch (e) { await itemUpdate(jobId, item.link, { status: 'failed', error: e.message }); }
      await redis('DEL', `feedjobwork:${jobId}:${index}`);
      await chainNext(jobId, index + 1, items.length);
      return res.status(200).json({ ok: true, index, gaveup: true });
    }

    return res.status(400).json({ error: `Unknown phase: ${phase}` });

  } catch (err) {
    console.error('feed-worker error:', err?.message || err);
    return res.status(500).json({ error: String(err?.message || 'Worker failed').slice(0, 300) });
  }
}
