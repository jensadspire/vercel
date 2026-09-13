/**
 * /api/kling — Kling AI video generation via fal.ai REST API
 * Model: Kling V3 Pro — multi-shot, cinematic, best quality
 * Uses start_image_url, generate_audio: false to suppress overlays
 * Polling: base model ID without subpath
 */

import { labelAndStore } from './_ai-label.js';

const KLING_SUBMIT = 'fal-ai/kling-video/v3/pro/image-to-video';
const KLING_BASE   = 'fal-ai/kling-video';

// ── Normalize any input image to 9:16 (720x1280) before sending to Kling ──────
// Kling V3 image-to-video IGNORES the aspect_ratio param and instead matches the
// OUTPUT aspect ratio to the INPUT IMAGE's proportions (confirmed in fal docs).
// So a landscape/square product photo -> landscape/square video, which then breaks
// the 9:16 outro template. Fix: pad every input image onto a 720x1280 canvas with
// a blurred, slightly-darkened copy of itself as the background, product centered
// and fully visible (never cropped). Result: Kling always sees 9:16 -> outputs 9:16.
async function padTo916(inputBuffer) {
  const sharp = (await import('sharp')).default;
  const W = 720, H = 1280;
  const background = await sharp(inputBuffer)
    .resize(W, H, { fit: 'cover' })      // fill frame for the blur bg (crop is fine — it's blurred)
    .blur(40)
    .modulate({ brightness: 0.7 })       // darken so the sharp product stands out
    .toBuffer();
  const foreground = await sharp(inputBuffer)
    .resize(W, H, { fit: 'inside' })     // whole product visible, never cropped
    .toBuffer();
  return sharp(background)
    .composite([{ input: foreground, gravity: 'center' }])
    .jpeg({ quality: 90 })
    .toBuffer();
}


export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const falKey = process.env.FAL_API_KEY;
  if (!falKey) return res.status(500).json({ error: 'FAL_API_KEY not configured' });

  const { imageUrl, storyboard, prompt, language = 'English', brand = '', logoUrl = null, overlayIntro = '', overlayOutro = '', action = 'create', requestId } = req.body || {};
  const authHeaders = { 'Authorization': `Key ${falKey}` };
  const jsonHeaders = { 'Authorization': `Key ${falKey}`, 'Content-Type': 'application/json' };

  const safeJson = async (r) => {
    try {
      const text = await r.text();
      if (!text || !text.trim()) return {};
      return JSON.parse(text);
    } catch (_) { return {}; }
  };

  try {
    // ── Poll existing task ──────────────────────────────────────────────────────
    if (action === 'poll' && requestId) {
      const statusRes = await fetch(
        `https://queue.fal.run/${KLING_BASE}/requests/${requestId}/status`,
        { method: 'GET', headers: authHeaders }
      );
      const statusData = await safeJson(statusRes);
      console.log('Status HTTP:', statusRes.status, 'status:', statusData.status);

      if (statusData.status === 'COMPLETED') {
        const resultRes = await fetch(
          `https://queue.fal.run/${KLING_BASE}/requests/${requestId}`,
          { method: 'GET', headers: authHeaders }
        );
        const result = await safeJson(resultRes);
        const rawVideoUrl = result.video?.url || result.video_url || null;
        console.log('COMPLETED - rawVideoUrl:', rawVideoUrl);

        // ── EU AI Act: label via Rendi + store to Blob (shared stage, fail-open) ──
        if (!rawVideoUrl) {
          return res.status(200).json({ status: 'COMPLETED', videoUrl: null });
        }
        const { url: videoUrl, labelled } = await labelAndStore(rawVideoUrl, 'kling');
        if (!labelled) console.error('[ai-label] Delivering UNLABELLED Kling video (Rendi unavailable)');
        return res.status(200).json({
          status: 'COMPLETED',
          videoUrl,
          labelled,
          ...(labelled ? {} : { labelNote: "Your video is ready. We couldn't add the AI-content label on this one — you can re-run it, or add the label before publishing." }),
        });
      }

      if (statusData.status === 'FAILED') {
        return res.status(200).json({ status: 'FAILED', videoUrl: null });
      }

      return res.status(200).json({ status: statusData.status || 'IN_QUEUE', videoUrl: null });
    }

    // ── Create new video task ───────────────────────────────────────────────────
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });

    // Build multi-shot prompt from storyboard.
    // The storyboard is AI-written and frequently directs on-screen text — a
    // "closing CTA button", brand name, tagline or domain — which Kling then
    // renders as garbled letterforms (the end-card seen in QA). We strip only
    // the TEXT-rendering cues from each scene and keep the visual direction.
    const stripTextCues = (str) => {
      if (!str) return '';
      // Tight text-noun list — words that almost exclusively mean ON-SCREEN TEXT, so
      // we never strip legit visual direction (a room that "opens up", a chair "shown").
      const CUE = /(text|caption|subtitle|title\s*card|end\s*-?\s*card|outro|intro\s*card|call\s*-?\s*to\s*-?\s*action|\bcta\b|button|tagline|slogan|headline|logo|watermark|overlay|brand\s*name|on[\s-]?screen|typography|lettering|word\s*mark|\bwords\b)/i;
      let out = String(str)
        // strip quoted copy (hooks/CTAs are quoted) — letter-guards protect possessives
        // like product's / chairs' from being mistaken for quote delimiters.
        .replace(/(?<![A-Za-z])["“'‘][^"”'’]{1,120}["”'’](?![A-Za-z])/g, ' ')
        // strip domains / URLs
        .replace(/\b(?:https?:\/\/)?[a-z0-9-]+\.(?:dk|com|net|io|co|shop|store|org|de|se|no|eu)\b/gi, ' ');
      // Drop sentences that (a) name a text element, or (b) are hook-style questions —
      // a "?" in a storyboard is on-screen hook copy ("Does your chair look like this?").
      out = out.split(/(?<=[.!?;])\s+/).filter(s => s && !CUE.test(s) && !/\?/.test(s)).join(' ');
      return out.replace(/\s{2,}/g, ' ').trim();
    };

    let scenePrompt = '';
    if (storyboard && storyboard.length > 0) {
      scenePrompt = storyboard
        .map(s => {
          const body = [stripTextCues(s.title), stripTextCues(s.description)].filter(Boolean).join(': ');
          return `(${s.timing}) ${body || 'the product in an elegant lifestyle scene, smooth cinematic camera movement'}`;
        })
        .join(' ');
    } else {
      scenePrompt = stripTextCues(prompt) || 'Cinematic product advertisement, smooth camera movement.';
    }

    // Video models can't render text or logos cleanly — any brand/CTA/overlay text
    // comes out as garbled letterforms (e.g. "now Nimara.dk" -> "now Mimarra.dk").
    // So we deliberately do NOT inject overlay/brand/logo/CTA text into the prompt,
    // and we actively suppress any text Kling might invent via the negative prompt.
    // (brand/overlayIntro/overlayOutro/logoUrl are still accepted for API compatibility
    // but intentionally unused here.) Clean footage only; brand/CTA text, if wanted,
    // should be burned in as a post-process (like the AI label), never drawn by Kling.
    const anchorInstruction = `This is a product advertisement video. The opening image shows the exact product — maintain 100% visual consistency with that product throughout every scene. Same product, same colors, same brand. Do not introduce different products or unrelated visuals. `;
    const videoPrompt = `${anchorInstruction}${scenePrompt}`.slice(0, 2500);
    const negativePrompt = `text, letters, words, typography, captions, subtitles, title card, intro card, end card, outro card, on-screen text, text overlay, signage, labels, logo, brand name, watermark, Chinese text, Korean text, Japanese text, Arabic text, foreign language overlays, different product, substitute product, unrelated objects, scene replacement, blur, distort, low quality`;

    // Fetch image, normalize to 9:16 (blurred-fill pad), and convert to base64.
    // Padding to 9:16 forces Kling to output 9:16 (it matches the input image's
    // proportions). Falls back to the original image if padding fails (fail-open).
    let imageData = imageUrl;
    try {
      const imgRes = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' } });
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        let outBuf = buf;
        let ct = imgRes.headers.get('content-type') || 'image/jpeg';
        try {
          outBuf = await padTo916(buf);   // -> 720x1280 jpeg
          ct = 'image/jpeg';
        } catch (padErr) {
          console.error('[kling] 9:16 pad failed, using original image:', padErr.message);
        }
        const b64 = outBuf.toString('base64');
        imageData = `data:${ct};base64,${b64}`;
      }
    } catch (_) {}

    const submitRes = await fetch(`https://queue.fal.run/${KLING_SUBMIT}`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        start_image_url: imageData,
        prompt: videoPrompt,
        negative_prompt: negativePrompt,
        duration: '10',
        aspect_ratio: '9:16',
        cfg_scale: 0.7,
        generate_audio: false,
      }),
    });

    const submitData = await safeJson(submitRes);
    console.log('Kling V3 Submit HTTP:', submitRes.status, 'requestId:', submitData.request_id);

    if (!submitRes.ok) {
      return res.status(500).json({
        error: submitData.detail || submitData.message || 'Kling generation failed',
        detail: JSON.stringify(submitData),
      });
    }

    return res.status(200).json({
      requestId: submitData.request_id,
      status: submitData.status || 'IN_QUEUE',
    });

  } catch (err) {
    console.error('Kling handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
