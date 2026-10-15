/**
 * AI Ad Studio Outreach — WAVE 2 ("new features" + Clerk invite)
 *
 * Sibling of send-outreach.js (Wave 1). Same engine patterns — reads Sheet1, uses
 * the 2-letter language code in column X, sends via Gmail, marks status in column L
 * — but with two differences:
 *   1. Copy: the "new features / connect to Google Ads + Meta" message (not the autolink intro).
 *   2. Link: a per-prospect Clerk invitation (via clerk-invite.js), NOT the RSA/Meta autolinks.
 *      Falls back to the plain signup page if minting fails, so the email always has a working CTA.
 *
 * send-outreach.js is left completely untouched. This file does not import or modify it.
 *
 * Usage:
 *   node outreach-wave2.js                 dry run (preview, no send, no invite minting)
 *   node outreach-wave2.js --send          send to all unsent (status col L empty or "Autolink")
 *   node outreach-wave2.js --send --limit 5
 *
 * Targets Sheet1 rows that are unsent and carry a valid column-X language code. Marks
 * column L "Wave2 <date>" on send, so Wave 1 and Wave 2 sends stay distinguishable and
 * no one is double-sent within a wave. Currently ships DA + EN copy; any other language
 * falls back to EN. Add languages by adding entries to WAVE2_TEMPLATES (same shape).
 *
 * NOTE: Both the DA and EN templates now link directly to the /invite page
 * (https://www.theaiad.studio/invite) instead of the dynamic per-prospect invite,
 * so the minted `invite` value is no longer placed in the email body. mintInvite()
 * is still called on --send below — remove that call if you don't need the invites
 * for tracking (otherwise every send mints an unused Clerk invitation).
 */

import 'dotenv/config';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import { mintInvite } from './clerk-invite.js';

const BASE_URL = 'https://www.theaiad.studio';
const SHEET_ID = '1SJfOXQuq-Q0FLLVGKkeD9y-GwKeZKxrJngkbLnZkPRw';
const SHEET_NAME = 'Database';
const SIGNUP_FALLBACK = 'https://accounts.theaiad.studio/sign-up';
const SHOWCASE_URL = 'https://www.theaiad.studio/showcase/'; // open overview (public:true cases only)
const LOGO_URL = 'https://www.theaiad.studio/apple-touch-icon.png'; // email header logo (hosted). Swap for a wordmark URL if preferred.

// Same column map as send-outreach.js
const COL = {
  company:  1,  // B
  name:     2,  // C
  title:    4,  // E
  email:    8,  // I
  status:   11, // L — human-readable log only (no longer drives selection)
  stage:    12, // M — wave stage integer (drives selection: send to stage N-1)
  language: 23, // X — 2-letter code
};

const SUPPORTED_LANGS = ['DA', 'SE', 'NO', 'DE', 'EN', 'NL', 'ES', 'IT', 'FR', 'PT'];

// ── Shared HTML wrapper + footer (identical to Wave 1) ──────────────────────
const wrapHtml = (bodyHtml) => `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a1a; line-height: 1.6;">

  <div style="text-align:center; margin: 4px 0 24px;">
    <img src="${LOGO_URL}" alt="AI Ad Studio" width="64" height="64" style="display:inline-block; width:64px; height:64px; border:0; border-radius:14px;" />
  </div>
${bodyHtml}

  <hr style="border:none; border-top:1px solid #e0e0e0; margin:24px 0;"/>
  <p style="font-size:11px; color:#888; line-height:1.6;">
    AI Ad Studio is developed by:<br/>
    <strong>Adspire Deutschland GmbH</strong> | Friedensallee 9 | D-22765 Hamburg<br/>
    Phone: +49 (0) 177 2466 220 |
    <a href="mailto:info@adspire.de" style="color:#888;">info@adspire.de</a> |
    <a href="https://www.adspire.de" style="color:#888;">www.adspire.de</a><br/>
    <a href="https://www.google.com/partners/agency?id=1294684995" style="color:#888;">Google Partner</a> – Search Advertising, Google Shopping
  </p>

</div>`;

// ── Wave 2 templates. ctx = { first, titleStr, company, invite } ────────────
// Both templates link directly to /invite (the minted `invite` value is unused).
const WAVE2_TEMPLATES = {
  // ── DA — Danish (Wave 2b, C2PA/AI Act update) ────────────────────────────
  DA: {
    subject: () => `AI Ad Studio: Google, Meta og TikTok annoncer klar til aktivering direkte fra URL`,
    body: ({ first, invite }) => `
  <p>Hej ${first},</p>

  <p>Black Friday er lige rundt om hjørnet, og er du på jagt efter nyt annoncemateriale til dine kampagner, så er <a href="https://www.theaiad.studio/features" style="color:#6366f1; font-weight:600; text-decoration:none;">AI Ad Studio</a> klar til at hjælpe dig.</p>

  <p><a href="https://www.theaiad.studio/" style="color:#6366f1; font-weight:600; text-decoration:none;">AI Ad Studio</a> er et gratis annonceværktøj, der forenkler annonce-workflows for e-commerce sites og marketingafdelinger.</p>

  <p><a href="https://www.theaiad.studio/" style="color:#6366f1; font-weight:600; text-decoration:none;">AI Ad Studio</a> udvikler færdigt annoncemateriale direkte fra Produkt- eller Kategori-URL på dit site. Indtast URL og modtag klargjorte annoncer til Google (Search Ads, PMax) samt til META (FB, IG, Carousel). Annoncerne kan herefter publiceres direkte til din Google Ads konto eller META ads manager.</p>

  <p>I løbet af den seneste måned har vi benyttet lejligheden til at bygge en række nye funktioner ind i <a href="https://www.theaiad.studio/" style="color:#6366f1; font-weight:600; text-decoration:none;">AI Ad Studio</a>, som nu kan kobles direkte op med Google Ads og Meta Business Manager. Derudover mærker vi automatisk alt AI-genereret videomateriale som "AI-genereret" og implementerer C2PA Content Credentials — med det mål at leve op til transparenskravene i EU's AI-forordning (AI Act).</p>

  <p>Ønsker du at teste <a href="https://www.theaiad.studio/" style="color:#6366f1; font-weight:600; text-decoration:none;">AI Ad Studio</a> og se, hvor nemt du færdiggør dine Google, Meta og TikTok annoncer, kan du oprette din <a href="https://www.theaiad.studio/invite" style="color:#6366f1; font-weight:600;">gratis brugeradgang her</a>.</p>

  <p>AI Ad Studio er et gratis værktøj og giver dig adgang til følgende funktioner:</p>
  <ul>
    <li>Google, Meta &amp; Video annonceudvikler på 35 forskellige sprog / markeder</li>
    <li>Audience brief generator med målgrupper, som jeres annoncer automatisk tilpasses til</li>
    <li>Direkte adgang til opkobling til Google Ads + Meta Ads Manager</li>
    <li>Automatisk eller individuel AI-model selector (Kling AI, Runway Recipe, Google VEO)</li>
  </ul>

  <p>Vi ser frem til at give dig nye muligheder til udvikling af dine markedsføringsaktiviteter.</p>

  <p style="margin-top:32px;">Mange hilsner<br/>
  <strong>Jens</strong><br/>
  AI Ad Studio</p>`,
  },

  // ── EN — English (Wave 2b; also the fallback for any non-DA language) ─────
  //        Direct translation of the DA copy above; links to /invite.
  EN: {
    subject: () => `AI Ad Studio: Google, Meta & TikTok ads ready to activate straight from a URL`,
    body: ({ first, invite }) => `
  <p>Hi ${first},</p>

  <p>Black Friday is just around the corner, and if you're on the hunt for fresh ad creative for your campaigns, <a href="https://www.theaiad.studio/features" style="color:#6366f1; font-weight:600; text-decoration:none;">AI Ad Studio</a> is ready to help.</p>

  <p><a href="https://www.theaiad.studio/" style="color:#6366f1; font-weight:600; text-decoration:none;">AI Ad Studio</a> is a free ad tool that simplifies ad workflows for e-commerce sites and marketing teams.</p>

  <p><a href="https://www.theaiad.studio/" style="color:#6366f1; font-weight:600; text-decoration:none;">AI Ad Studio</a> builds finished ad creative directly from a product or category URL on your site. Enter a URL and receive ready-made ads for Google (Search Ads, PMax) and Meta (FB, IG, Carousel). The ads can then be published directly to your Google Ads account or Meta Ads Manager.</p>

  <p>Over the past month we've taken the opportunity to build a range of new features into <a href="https://www.theaiad.studio/" style="color:#6366f1; font-weight:600; text-decoration:none;">AI Ad Studio</a>, which now connect directly to Google Ads and Meta Business Manager. In addition, we automatically label all AI-generated video as "AI-generated" and implement C2PA Content Credentials — with the goal of meeting the transparency requirements of the EU AI Act.</p>

  <p>If you'd like to test <a href="https://www.theaiad.studio/" style="color:#6366f1; font-weight:600; text-decoration:none;">AI Ad Studio</a> and see how easily you can finish your Google, Meta and TikTok ads, you can create your <a href="https://www.theaiad.studio/invite" style="color:#6366f1; font-weight:600;">free account here</a>.</p>

  <p>AI Ad Studio is a free tool and gives you access to the following features:</p>
  <ul>
    <li>Google, Meta &amp; Video ad builder in 35 different languages / markets</li>
    <li>Audience brief generator with audiences your ads are automatically tailored to</li>
    <li>Direct connection to Google Ads + Meta Ads Manager</li>
    <li>Automatic or manual AI-model selector (Kling AI, Runway Recipe, Google VEO)</li>
  </ul>

  <p>We look forward to opening up new possibilities for developing your marketing activities.</p>

  <p style="margin-top:32px;">Kind regards,<br/>
  <strong>Jens</strong><br/>
  AI Ad Studio</p>`,
  },
};

// ── Build one Wave 2 email ──────────────────────────────────────────────────
const buildEmail = async ({ name, company, title, language, email }, { send }) => {
  const first = (name || 'there').split(' ')[0];
  const titleStr = title || 'E-commerce Manager';

  // Mint a Clerk invite only on a real send; dry-run uses the fallback.
  // NOTE: the templates now link to /invite directly, so this value is no longer
  // placed in the email body — kept for tracking / future use.
  let invite = SIGNUP_FALLBACK;
  if (send) {
    const url = await mintInvite(email, { source: 'wave2', lang: language });
    if (url) invite = url;
  }

  const tpl = WAVE2_TEMPLATES[language] || WAVE2_TEMPLATES.EN;
  const ctx = { first, titleStr, company, invite };
  return { subject: tpl.subject(ctx), html: wrapHtml(tpl.body(ctx)), invite, usedLang: WAVE2_TEMPLATES[language] ? language : 'EN' };
};

// ── Sheet helpers ───────────────────────────────────────────────────────────
async function getSheetData() {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A2:AA500` });
  return { sheets, rows: res.data.values || [] };
}

async function markSent(sheets, rowIndex) {
  const iso = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (unambiguous, sortable)
  const sheetRow = rowIndex + 2;
  // Advance stage to 2 (column M) AND write a clean human log to L ("W2 · YYYY-MM-DD").
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${SHEET_NAME}!M${sheetRow}`, values: [[2]] },
        { range: `${SHEET_NAME}!L${sheetRow}`, values: [[`W2 · ${iso}`]] },
      ],
    },
  });
}

const delay = ms => new Promise(r => setTimeout(r, ms));
const doSend = process.argv.includes('--send');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg !== -1 ? parseInt(process.argv[limitArg + 1]) : Infinity;

async function run() {
  console.log(`\n📧 AI Ad Studio Outreach — WAVE 2 ${doSend ? '— LIVE SEND' : '— DRY RUN'}\n`);

  const { sheets, rows } = await getSheetData();

  // Wave 2 recipients = stage 1 (received Wave 1, ready for Wave 2). Column M drives this.
  // stage 0 = never contacted (needs Wave 1 first); stage 2 = already got Wave 2.
  const WAVE = 2;
  const REQUIRED_STAGE = WAVE - 1; // Wave 2 sends to stage 1
  const candidates = rows
    .map((row, i) => ({ row, i }))
    .filter(({ row }) =>
      row[COL.email]?.includes('@') &&
      parseInt((row[COL.stage] ?? '').toString().trim() || '-1', 10) === REQUIRED_STAGE
    );

  const withLanguage = [];
  const skipped = [];
  for (const { row, i } of candidates) {
    const lang = (row[COL.language] || '').trim().toUpperCase();
    if (SUPPORTED_LANGS.includes(lang)) withLanguage.push({ row, i, lang });
    else skipped.push({ row, i, lang: lang || '(empty)' });
  }

  if (skipped.length) {
    console.log(`⚠️  Skipping ${skipped.length} prospect(s) — missing/invalid language code in column X:`);
    for (const { row, i, lang } of skipped) {
      console.log(`   Row ${i + 2}: ${row[COL.name] || '?'} <${row[COL.email]}> — value: ${lang}`);
    }
    console.log('');
  }

  const prospects = withLanguage.slice(0, limit).map(({ row, i, lang }) => ({
    i,
    name: row[COL.name] || 'there',
    company: row[COL.company] || '',
    title: row[COL.title] || 'E-commerce Manager',
    email: row[COL.email],
    language: lang,
  }));

  console.log(`Found ${prospects.length} prospect(s) ready for Wave 2${skipped.length ? ` (${skipped.length} skipped)` : ''}\n`);
  if (!prospects.length) { console.log('No unsent prospects with a valid language code.'); return; }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  for (const [idx, p] of prospects.entries()) {
    const { subject, html, invite, usedLang } = await buildEmail(p, { send: doSend });

    console.log(`${idx + 1}/${prospects.length} [${p.language}${usedLang !== p.language ? `→${usedLang}` : ''}] ${p.name} <${p.email}>`);
    console.log(`   Company: ${p.company}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   CTA:     ${invite}`);

    if (doSend) {
      try {
        await transporter.sendMail({ from: `"AI Ad Studio" <${process.env.GMAIL_USER}>`, to: p.email, subject, html });
        console.log(`   ✅ Sent`);
        await markSent(sheets, p.i);
      } catch (err) {
        console.log(`   ❌ Error: ${err.message}`);
      }
      if (idx < prospects.length - 1) await delay(5000);
    }
    console.log();
  }

  console.log(doSend
    ? `✅ Done — ${prospects.length} Wave 2 email(s) processed${skipped.length ? `, ${skipped.length} skipped` : ''}`
    : `🔍 Dry run complete — run with --send to actually send`
  );
}

run().catch(console.error);
