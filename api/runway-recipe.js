/**
 * /api/runway-recipe — Runway Recipes (Product Ad + Product UGC) via @runwayml/sdk
 *
 * Mirrors the create→poll contract of /api/runway so the existing frontend
 * polling loop works unchanged:
 *   create (default): { taskId, status }   OR   { gated:true, count, limit } when over the monthly cap
 *   poll:             { status, videoUrl, progress }
 *
 * ── MONTHLY METER (spend control) ──────────────────────────────────────────
 * Recipe generations are expensive (~$2.40 each), so every user — INCLUDING
 * signed-in and Pro users — is capped at RECIPE_MONTHLY_LIMIT per calendar month.
 * (This deliberately differs from /api/generate, where signed-in users are
 * unlimited, because Recipe cost is the thing being controlled.)
 *   - key:        recipe:{clerkUserId}:{YYYY-MM}   (calendar month -> resets on the 1st)
 *   - checked:    on the CREATE path, before calling Runway (before any $ is committed)
 *   - incremented: only AFTER a successful create (task accepted = Runway starts billing);
 *                  failed creates do not count against the user
 *   - admin:      x-admin-key bypasses the cap entirely (unlimited, for testing)
 *   - fail mode:  FAIL CLOSED — if Redis is unreachable, Recipe is refused
 *                 ("try again shortly"), because the whole point is protecting spend.
 *   - identity:   Clerk user id (payload.sub) from the x-clerk-session JWT.
 *                 Recipe is only reachable by signed-in users (TikTok tab gates on
 *                 isSignedIn), so there is no anonymous path.
 */

import RunwayML from '@runwayml/sdk';

const RECIPE_VERSION = '2026-06';
const RATIO = '720:1280'; // 9:16 TikTok-native
const RECIPE_MONTHLY_LIMIT = 10;              // gens per user per calendar month
const RECIPE_KEY_TTL_SECS = 40 * 24 * 60 * 60; // ~40d cleanup so stale month keys expire

// ── EU AI Act visible-label config (Phase 1: Recipe only) ────────────────────
// AI_LABEL_TEXT is the single source of truth for the disclosure wording.
// Legal can change this one string; everything else stays put.
const AI_LABEL_TEXT = 'AI-generated';
const RENDI_API_URL = 'https://api.rendi.dev/v1';
const RENDI_POLL_MS = 2500;        // gap between Rendi status polls
const RENDI_MAX_POLLS = 24;        // ~60s ceiling for a short 9:16 clip
const RENDI_SUBMIT_TIMEOUT_MS = 15000;

/**
 * Burn a visible "AI-generated" label onto a video via Rendi (hosted ffmpeg).
 * Input: a public video URL (Runway's outputUrl). Returns: a labelled video URL,
 * or null on any failure (caller then FAILS OPEN to the original video).
 *
 * drawtext: semi-transparent white text on a subtle dark box, bottom-right,
 * scaled to the video height so it reads on 9:16 without dominating.
 */
async function addAiLabelViaRendi(videoUrl) {
  const key = process.env.RENDI_API_KEY;
  if (!key) { console.error('[ai-label] RENDI_API_KEY not set — skipping label (fail-open)'); return null; }

  // Escape single quotes for the ffmpeg drawtext text= value.
  const safeText = String(AI_LABEL_TEXT).replace(/'/g, "\\'");
  // box=1 draws a translucent background behind the text for legibility on any scene.
  // fontsize scales with height (h/22); positioned bottom-right with padding.
  const drawtext =
    "drawtext=text='" + safeText + "':" +
    "fontcolor=white@0.95:fontsize=h/22:box=1:boxcolor=black@0.45:boxborderw=12:" +
    "x=w-tw-40:y=h-th-40";
  const ffmpeg_command =
    "-i {{in_1}} -vf \"" + drawtext + "\" -c:a copy -movflags +faststart {{out_1}}";

  try {
    // ── submit ────────────────────────────────────────────────────────────────
    const submitRes = await fetch(RENDI_API_URL + '/run-ffmpeg-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
      body: JSON.stringify({
        input_files: { in_1: videoUrl },
        output_files: { out_1: 'labelled.mp4' },
        ffmpeg_command,
      }),
      signal: AbortSignal.timeout(RENDI_SUBMIT_TIMEOUT_MS),
    });
    const submitData = await submitRes.json().catch(() => ({}));
    if (!submitRes.ok) {
      console.error('[ai-label] Rendi submit failed:', submitRes.status, JSON.stringify(submitData).slice(0, 300));
      return null;
    }
    const commandId = submitData.command_id || submitData.id || submitData.commandId;
    if (!commandId) {
      console.error('[ai-label] Rendi submit returned no command_id:', JSON.stringify(submitData).slice(0, 300));
      return null;
    }

    // ── poll ──────────────────────────────────────────────────────────────────
    for (let i = 0; i < RENDI_MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, RENDI_POLL_MS));
      const pollRes = await fetch(RENDI_API_URL + '/commands/' + commandId, {
        method: 'GET',
        headers: { 'X-API-KEY': key },
      });
      const pollData = await pollRes.json().catch(() => ({}));
      const status = (pollData.status || '').toUpperCase();

      if (status === 'SUCCESS' || status === 'SUCCEEDED' || status === 'COMPLETED') {
        // Output file URL: try common shapes in Rendi's response.
        const out =
          pollData.output_files?.out_1?.storage_url ||
          pollData.output_files?.out_1 ||
          pollData.output_files?.[0]?.storage_url ||
          pollData.result?.[0]?.storage_url ||
          null;
        if (!out) {
          console.error('[ai-label] Rendi SUCCESS but no output url:', JSON.stringify(pollData).slice(0, 300));
          return null;
        }
        return typeof out === 'string' ? out : (out.storage_url || null);
      }
      if (status === 'FAILED' || status === 'ERROR') {
        console.error('[ai-label] Rendi command failed:', JSON.stringify(pollData).slice(0, 300));
        return null;
      }
      // else still processing → keep polling
    }
    console.error('[ai-label] Rendi timed out after', RENDI_MAX_POLLS, 'polls — fail-open');
    return null;
  } catch (e) {
    console.error('[ai-label] Rendi request error (fail-open):', e.message);
    return null;
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
};

// ── Upstash Redis helper (REST API — same pattern as /api/generate) ──────────
async function redis(command, ...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { ok: false, result: null }; // not configured
  const res = await fetch(`${url}/${[command, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`redis ${command} http ${res.status}`);
  const data = await res.json();
  return { ok: true, result: data.result };
}

// Current calendar month as YYYY-MM (UTC)
function currentMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Decode Clerk session JWT -> user id (payload.sub), or null. (Same decode as /api/generate.)
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-clerk-session, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const runwayKey = process.env.RUNWAY_API_KEY;
  if (!runwayKey) return res.status(500).json({ error: 'Runway API key not configured' });

  const client = new RunwayML({ apiKey: runwayKey });

  const {
    action = 'create',
    taskId,
    mode = 'ad',
    imageUrl,
    characterImage,
    productImages,
    productInfo,
    userConcept,
    duration,
  } = req.body || {};

  try {
    // ── Poll ─────────────────────────────────────────────────────────────────
    // Poll is not metered (the create already counted). Left unchanged.
    if (action === 'poll' && taskId) {
      const task = await client.tasks.retrieve(taskId);

      if (task.status !== 'SUCCEEDED') {
        // On failure, surface Runway's reason so the frontend + Vercel logs show WHY.
        if (task.status === 'FAILED' || task.status === 'CANCELLED') {
          const failure = task.failure || task.failureReason || null;
          const failureCode = task.failureCode || null;
          console.error('Recipe task', task.status + ':', failureCode || '(no code)', '-', failure || '(no reason provided)');
          return res.status(200).json({
            status: task.status,
            videoUrl: null,
            progress: task.progress || 0,
            failure,
            failureCode,
          });
        }
        return res.status(200).json({
          status: task.status,
          videoUrl: null,
          progress: task.progress || 0,
        });
      }

      const outputUrl = Array.isArray(task.output) ? task.output[0] : (task.output?.url || task.output);
      if (!outputUrl) {
        return res.status(200).json({ status: 'FAILED', videoUrl: null, error: 'No output URL on succeeded task' });
      }

      // ── EU AI Act: burn visible "AI-generated" label via Rendi (fail-open) ──
      // Label Runway's output first; if Rendi fails we fall back to the original
      // video so the user never loses their (paid) generation.
      let sourceUrl = outputUrl;
      let labelled = false;
      const labelledUrl = await addAiLabelViaRendi(outputUrl);
      if (labelledUrl) { sourceUrl = labelledUrl; labelled = true; }
      else { console.error('[ai-label] Delivering UNLABELLED Recipe video (Rendi unavailable) — mode:', mode); }

      let blobUrl = sourceUrl;
      try {
        const vidRes = await fetch(sourceUrl);
        if (!vidRes.ok) throw new Error(`download ${vidRes.status}`);
        const buf = Buffer.from(await vidRes.arrayBuffer());
        const { put } = await import('@vercel/blob');
        const blob = await put(`recipe-${mode}-${Date.now()}.mp4`, buf, {
          access: 'public',
          contentType: 'video/mp4',
          token: process.env.BLOB_READ_WRITE_TOKEN,
        });
        blobUrl = blob.url;
      } catch (storeErr) {
        console.error('Recipe Blob store failed, returning temp URL:', storeErr.message);
      }

      return res.status(200).json({
        status: 'SUCCEEDED',
        videoUrl: blobUrl,
        progress: 1,
        labelled,
        ...(labelled ? {} : { labelNote: "Your video is ready. We couldn't add the AI-content label on this one — you can re-run it, or add the label before publishing." }),
      });
    }

    // ── Create ────────────────────────────────────────────────────────────────
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl (product image) required' });

    // ── Monthly meter (spend gate) ────────────────────────────────────────────
    const adminKey = process.env.ADMIN_KEY;
    const isAdmin = adminKey && (req.headers['x-admin-key'] || '') === adminKey;

    let meterKey = null;   // set when we should increment after a successful create
    let currentCount = 0;

    if (!isAdmin) {
      const userId = clerkUserId(req);
      // Recipe is signed-in-only; a missing/invalid session should not silently
      // bypass the cap. Refuse rather than allow an uncounted expensive gen.
      if (!userId) {
        return res.status(401).json({ error: 'Sign in required for Recipe generation.' });
      }

      meterKey = `recipe:${userId}:${currentMonth()}`;

      // FAIL CLOSED: any Redis problem -> refuse (protect spend), do not call Runway.
      let getRes;
      try {
        getRes = await redis('GET', meterKey);
      } catch (e) {
        console.error('Recipe meter GET failed (failing closed):', e.message);
        return res.status(503).json({ error: 'Usage service temporarily unavailable — please try again shortly.' });
      }
      if (!getRes.ok) {
        // Redis not configured at all -> also fail closed for this expensive path.
        console.error('Recipe meter: Redis not configured (failing closed)');
        return res.status(503).json({ error: 'Usage service temporarily unavailable — please try again shortly.' });
      }

      currentCount = parseInt(getRes.result || '0', 10);
      if (currentCount >= RECIPE_MONTHLY_LIMIT) {
        return res.status(200).json({
          gated: true,
          count: currentCount,
          limit: RECIPE_MONTHLY_LIMIT,
          message: `You've reached your monthly limit of ${RECIPE_MONTHLY_LIMIT} Runway Recipe generations.`,
        });
      }
    }

    // ── Call Runway (create) ──────────────────────────────────────────────────
    let task;
    if (mode === 'ugc') {
      if (!characterImage) return res.status(400).json({ error: 'characterImage required for UGC mode' });
      task = await client.recipes.productUgc({
        version: RECIPE_VERSION,
        characterImage: { uri: characterImage },
        productImage: { uri: imageUrl },
        ...(productInfo ? { productInfo: String(productInfo).slice(0, 2500) } : {}),
        ...(userConcept ? { userConcept: String(userConcept).slice(0, 3500) } : {}),
        ...(duration ? { duration } : {}),
        ratio: RATIO,
      });
    } else {
      const imgs = (Array.isArray(productImages) && productImages.length ? productImages : [imageUrl])
        .slice(0, 10)
        .map(uri => ({ uri }));
      task = await client.recipes.productAd({
        version: RECIPE_VERSION,
        productImages: imgs,
        ...(productInfo ? { productInfo: String(productInfo).slice(0, 2500) } : {}),
        ...(userConcept ? { userConcept: String(userConcept).slice(0, 3500) } : {}),
        ...(duration ? { duration } : {}),
        ratio: RATIO,
      });
    }

    // ── Increment ONLY after a successful create (task accepted = billing starts) ──
    // A failure above throws to catch and never reaches here, so failed creates
    // do not count against the user's monthly quota.
    let newCount = currentCount;
    if (meterKey) {
      try {
        if (currentCount === 0) {
          // First gen this month — set with a cleanup TTL so stale month keys expire.
          await redis('SET', meterKey, 1, 'EX', RECIPE_KEY_TTL_SECS);
        } else {
          await redis('INCR', meterKey);
        }
        newCount = currentCount + 1;
      } catch (e) {
        // The gen already succeeded; don't fail the user's request over a count write.
        // Worst case the user gets one uncounted gen — acceptable vs. blocking a paid task.
        console.error('Recipe meter increment failed (gen already created):', e.message);
      }
    }

    return res.status(200).json({
      taskId: task.id,
      status: task.status || 'PENDING',
      usage_count: newCount,
      usage_limit: RECIPE_MONTHLY_LIMIT,
      gated: false,
    });

  } catch (err) {
    const detail = err?.error?.error || err?.message || 'Runway recipe failed';
    console.error('runway-recipe error:', detail);
    return res.status(500).json({ error: String(detail).slice(0, 300) });
  }
}
