/**
 * /api/_ai-label.js — shared EU AI Act compliance stage for all video engines.
 *
 * Single source of truth for:
 *   - AI_LABEL_TEXT           the visible disclosure wording (legal changes this ONE line)
 *   - addAiLabelViaRendi()    burn the visible "AI-generated" label via Rendi (hosted ffmpeg)
 *   - labelAndStore()         label a video URL then store the result to Vercel Blob
 *
 * Used by runway-recipe.js, kling.js, runway.js so every engine's output is
 * treated identically. When C2PA signing is added later, it hooks in here too,
 * so all engines get it at once.
 *
 * FAIL-OPEN throughout: if Rendi errors/times out we return the original video
 * so the user never loses their generation; callers log and carry on.
 */

// ── EU AI Act visible-label config ───────────────────────────────────────────
// AI_LABEL_TEXT is the single source of truth for the disclosure wording.
export const AI_LABEL_TEXT = 'AI-generated';

const RENDI_API_URL = 'https://api.rendi.dev/v1';
const RENDI_POLL_MS = 2500;        // gap between Rendi status polls
const RENDI_MAX_POLLS = 24;        // ~60s ceiling for a short 9:16 clip
const RENDI_SUBMIT_TIMEOUT_MS = 15000;
const RENDI_429_RETRIES = 3;       // retry attempts on rate-limit (429)
const RENDI_429_WAIT_MS = 20000;   // wait between 429 retries (Rendi quota is per-minute)

/**
 * Burn a visible "AI-generated" label onto a video via Rendi (hosted ffmpeg).
 * @param {string} videoUrl - public URL of the source video (engine output).
 * @returns {Promise<string|null>} labelled video URL, or null on any failure.
 *
 * drawtext: semi-transparent white text on a subtle dark box, bottom-right,
 * scaled to the video height so it reads on 9:16 without dominating.
 */
export async function addAiLabelViaRendi(videoUrl) {
  const key = process.env.RENDI_API_KEY;
  if (!key) { console.error('[ai-label] RENDI_API_KEY not set — skipping label (fail-open)'); return null; }

  const safeText = String(AI_LABEL_TEXT).replace(/'/g, "\\'");
  const drawtext =
    "drawtext=text='" + safeText + "':" +
    "fontcolor=white@0.95:fontsize=h/22:box=1:boxcolor=black@0.45:boxborderw=12:" +
    "x=w-tw-40:y=h-th-40";
  const ffmpeg_command =
    '-i {{in_1}} -vf "' + drawtext + '" -c:a copy -movflags +faststart {{out_1}}';

  try {
    // ── submit (with retry on 429 rate-limit — Rendi quota is per-minute) ────────
    let submitRes, submitData;
    for (let attempt = 0; ; attempt++) {
      submitRes = await fetch(RENDI_API_URL + '/run-ffmpeg-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
        body: JSON.stringify({
          input_files: { in_1: videoUrl },
          output_files: { out_1: 'labelled.mp4' },
          ffmpeg_command,
        }),
        signal: AbortSignal.timeout(RENDI_SUBMIT_TIMEOUT_MS),
      });
      submitData = await submitRes.json().catch(() => ({}));
      if (submitRes.status === 429 && attempt < RENDI_429_RETRIES) {
        console.error('[ai-label] Rendi 429 rate-limit — retry ' + (attempt + 1) + '/' + RENDI_429_RETRIES + ' in ' + (RENDI_429_WAIT_MS / 1000) + 's');
        await new Promise(r => setTimeout(r, RENDI_429_WAIT_MS));
        continue;
      }
      break;
    }
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

// ── C2PA signing (Cloud Run signing service, authenticated via GCP IAM) ──────
const SIGN_TIMEOUT_MS = 60000; // the service fetches + signs the video server-side

/**
 * C2PA-sign a (labelled) video via the private Cloud Run signing service and
 * return the signed MP4 bytes. Two-layer auth: a Google ID token (GCP IAM, from
 * a service-account key in SIGNING_SA_KEY, audience = the service URL) PLUS the
 * x-internal-token shared secret. Fail-open: returns null on any failure.
 *
 * @param {string} videoUrl - public URL of the (labelled) video to sign.
 * @param {string} brand    - brand for the manifest title.
 * @returns {Promise<Buffer|null>} signed MP4 bytes, or null on any failure.
 */
async function signC2PA(videoUrl, brand = '') {
  const base = (process.env.SIGNING_SERVICE_URL || '').replace(/\/$/, '');
  const secret = process.env.SIGNING_INTERNAL_TOKEN;
  const saKey = process.env.SIGNING_SA_KEY;
  if (!base || !secret || !saKey) {
    console.error('[c2pa] signing not configured (SIGNING_SERVICE_URL / SIGNING_INTERNAL_TOKEN / SIGNING_SA_KEY) — skipping (fail-open)');
    return null;
  }
  try {
    // Mint a Google ID token for the Cloud Run service (audience = service base URL).
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({ credentials: JSON.parse(saKey) });
    const idClient = await auth.getIdTokenClient(base);
    const idToken = await idClient.idTokenProvider.fetchIdToken(base);

    const res = await fetch(base + '/sign', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + idToken,
        'x-internal-token': secret,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ videoUrl, brand, compositesRealImage: true }),
      signal: AbortSignal.timeout(SIGN_TIMEOUT_MS),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      console.error('[c2pa] sign failed:', res.status, msg.slice(0, 200));
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2000) { // a real signed MP4 is MBs; a tiny body is an error
      console.error('[c2pa] sign returned suspiciously small output (' + buf.length + ' bytes) — fail-open');
      return null;
    }
    return buf;
  } catch (e) {
    console.error('[c2pa] sign error (fail-open):', e.message);
    return null;
  }
}

/**
 * Label a video URL, then store the (labelled or, on failure, original) video to
 * Vercel Blob. For engines that DON'T already re-host (Kling, Runway-regular):
 * this adds the whole download→label→Blob stage they lack.
 *
 * @param {string} sourceUrl - the engine's output video URL.
 * @param {string} filenamePrefix - Blob filename prefix, e.g. 'kling' or 'runway'.
 * @returns {Promise<{url: string, labelled: boolean, signed: boolean, stored: boolean}>}
 *   url:      the URL to return to the user (Blob URL when stored, else a fallback)
 *   labelled: whether the AI label was successfully burned in
 *   signed:   whether the video was C2PA-signed
 *   stored:   whether the video is now on our Blob (vs the engine's original URL)
 *
 * FAIL-OPEN at every step: label failure → store the original; sign failure →
 * store the labelled-but-unsigned video; store failure → return the working URL.
 *
 * @param {object} [opts] - { brand } for the C2PA manifest title.
 */
export async function labelAndStore(sourceUrl, filenamePrefix, opts = {}) {
  // 1) label (fail-open: fall back to the original engine URL)
  let workingUrl = sourceUrl;
  let labelled = false;
  const labelledUrl = await addAiLabelViaRendi(sourceUrl);
  if (labelledUrl) { workingUrl = labelledUrl; labelled = true; }
  else { console.error('[ai-label] Delivering UNLABELLED', filenamePrefix, 'video (Rendi unavailable)'); }

  // 2) C2PA-sign the (labelled) video. Fail-open: on failure signedBuf stays null
  //    and step 3 downloads + stores the unsigned working video instead.
  const signedBuf = await signC2PA(workingUrl, opts.brand || '');
  const signed = !!signedBuf;
  if (!signed) console.error('[c2pa] Delivering UNSIGNED', filenamePrefix, 'video (signing unavailable)');

  // 3) store to Blob — the signed bytes if we have them, else download the working video
  let outUrl = workingUrl;
  let stored = false;
  try {
    let buf = signedBuf;
    if (!buf) {
      const vidRes = await fetch(workingUrl);
      if (!vidRes.ok) throw new Error(`download ${vidRes.status}`);
      buf = Buffer.from(await vidRes.arrayBuffer());
    }
    const { put } = await import('@vercel/blob');
    const blob = await put(`${filenamePrefix}-${Date.now()}.mp4`, buf, {
      access: 'public',
      contentType: 'video/mp4',
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    outUrl = blob.url;
    stored = true;
  } catch (storeErr) {
    // Fail-open: return the working URL (labelled temp URL, or original) unstored.
    console.error('[ai-label]', filenamePrefix, 'Blob store failed, returning unstored URL:', storeErr.message);
  }

  return { url: outUrl, labelled, signed, stored };
}
