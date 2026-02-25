import { useState, useRef, useCallback } from "react";

// ── Constants ─────────────────────────────────────────────────────────────────
const HL_LIMIT = 30, DESC_LIMIT = 90, PATH_LIMIT = 15;
const NUM_HL = 15, NUM_DESC = 4;

const TSV_HEADERS = [
  "Campaign", "Ad Group",
  ...Array.from({ length: NUM_HL }, (_, i) => `Headline ${i + 1}`),
  ...Array.from({ length: NUM_DESC }, (_, i) => `Description ${i + 1}`),
  "Path 1", "Path 2", "Final URL",
];

const IMPORT_STEPS = [
  { n: "01", text: "Open Google Ads Editor, download account (Ctrl+Shift+T)" },
  { n: "02", text: "Left panel \u2192 Ads \u2192 Responsive search ads" },
  { n: "03", text: 'Click "Make multiple changes"' },
  { n: "04", text: 'Set Destination \u2192 "My data includes columns for campaigns / ad groups"' },
  { n: "05", text: 'Click "Paste from clipboard" \u2014 done!' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeRow(id) {
  return {
    id,
    campaign: "", adGroup: "",
    headlines: Array.from({ length: NUM_HL }, () => ({ text: "", pin: "" })),
    descriptions: Array.from({ length: NUM_DESC }, () => ({ text: "", pin: "" })),
    path1: "", path2: "", finalUrl: "",
  };
}

function buildTSV(rows, omitGroup = false) {
  const headers = omitGroup
    ? TSV_HEADERS.filter(h => h !== "Campaign" && h !== "Ad Group")
    : TSV_HEADERS;
  return [
    headers.join("\t"),
    ...rows.map(r => {
      const cells = omitGroup ? [] : [r.campaign, r.adGroup];
      return [
        ...cells,
        ...r.headlines.map(h => h.text),
        ...r.descriptions.map(d => d.text),
        r.path1, r.path2, r.finalUrl,
      ].join("\t");
    }),
  ].join("\n");
}

// DESC_GRACE: descriptions 91-93 chars are "tolerated" (yellow), >93 is over (red)
const DESC_GRACE = 3; // chars above DESC_LIMIT still accepted

function charInfo(text, limit, isDesc = false) {
  const n = text.length;
  const hardLimit = isDesc ? limit + DESC_GRACE : limit;
  const over = n > hardLimit;
  const grace = isDesc && !over && n > limit;          // 91-93: yellow
  const warn  = !over && !grace && n > limit * 0.87;  // ~79-90: soft amber
  const color = over ? "#ff4d4d" : grace ? "#f59e0b" : warn ? "#fbbf24" : "#34d399";
  return { n, over, grace, warn, color };
}

// Smart description trimmer: keep text if <=93 chars, else trim to last complete word
function smartTrimDesc(text) {
  if (text.length <= DESC_LIMIT + DESC_GRACE) return text; // 91-93: keep as-is
  // >93: trim to last complete word boundary at or before DESC_LIMIT
  const cut = text.slice(0, DESC_LIMIT);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function AdStrengthRing({ headlines, descriptions }) {
  const validH = headlines.filter(h => h.text.trim() && h.text.length <= HL_LIMIT).length;
  const validD = descriptions.filter(d => d.text.trim() && d.text.length <= DESC_LIMIT + DESC_GRACE).length;
  const score = Math.round((validH / NUM_HL) * 60 + (validD / NUM_DESC) * 40);

  const label = score >= 90 ? "Excellent" : score >= 70 ? "Good" : score >= 45 ? "Average" : "Poor";
  const color = { Excellent: "#34d399", Good: "#a3e635", Average: "#fbbf24", Poor: "#f87171" }[label];

  const r = 28, circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <svg width={68} height={68} style={{ flexShrink: 0 }}>
        <circle cx={34} cy={34} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={6} />
        <circle cx={34} cy={34} r={r} fill="none" stroke={color} strokeWidth={6}
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeDashoffset={circ / 4}
          strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.6s ease" }}
        />
        <text x={34} y={34} textAnchor="middle" dominantBaseline="central"
          style={{ fill: "white", fontSize: 13, fontWeight: 800, fontFamily: "monospace" }}>
          {score}
        </text>
      </svg>
      <div>
        <div style={{ fontSize: 16, fontWeight: 800, color, letterSpacing: "-0.01em" }}>{label}</div>
        <div style={{ fontSize: 11, color: "#64748b", marginTop: 2, lineHeight: 1.4 }}>
          {validH}/{NUM_HL} headlines<br />{validD}/{NUM_DESC} descriptions
        </div>
      </div>
    </div>
  );
}

function SerpPreview({ row }) {
  const hs = row.headlines.map(h => h.text).filter(Boolean);
  const ds = row.descriptions.map(d => d.text).filter(Boolean);
  const domain = (row.finalUrl || "yoursite.com").replace(/https?:\/\/(www\.)?/, "").split("/")[0];
  const path = [row.path1, row.path2].filter(Boolean).join("/");
  const displayUrl = domain + (path ? `/${path}` : "");

  // Show 3 random headlines, 2 descriptions
  const [seed] = useState(() => Math.random());
  const pick = (arr, n) => arr.length <= n ? arr : arr.slice(0, n);
  const shownH = pick(hs, 3);
  const shownD = pick(ds, 2);

  return (
    <div style={{
      background: "#fff",
      borderRadius: 10,
      padding: "16px 18px",
      fontFamily: "Arial, sans-serif",
      boxShadow: "0 2px 16px rgba(0,0,0,0.18)",
    }}>
      {/* Ad badge + URL */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
        <span style={{
          fontSize: 10, fontWeight: 700, color: "#006621",
          border: "1px solid #006621", borderRadius: 3, padding: "1px 4px"
        }}>Ad</span>
        <span style={{ fontSize: 13, color: "#202124" }}>
          {displayUrl || "yoursite.com"}
        </span>
      </div>
      {/* Headline */}
      <div style={{ fontSize: 19, color: "#1a0dab", lineHeight: 1.25, marginBottom: 5, fontWeight: 400 }}>
        {shownH.length > 0
          ? shownH.join(" | ")
          : <span style={{ color: "#bbb" }}>Headline 1 | Headline 2 | Headline 3</span>}
      </div>
      {/* Descriptions */}
      <div style={{ fontSize: 13, color: "#3c4043", lineHeight: 1.55 }}>
        {shownD.length > 0
          ? shownD.join(" ")
          : <span style={{ color: "#ccc" }}>Your description will appear here once generated.</span>}
      </div>
    </div>
  );
}

function EditableField({ label, value, limit, onChange, pinValue, onPinChange, mono = true, isDesc = false, refineContext }) {
  const { n, over, grace, warn, color } = charInfo(value, limit, isDesc);
  const [showRefine, setShowRefine] = useState(false);
  const [refineText, setRefineText] = useState("");
  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState("");
  const [hovered, setHovered] = useState(false);

  const handleRefine = async () => {
    if (!refineText.trim() || refining) return;
    setRefining(true); setRefineError("");
    try {
      const res = await fetch("/api/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current: value,
          instruction: refineText.trim(),
          limit,
          isDesc,
          language: refineContext?.language || "English",
          url: refineContext?.url || "",
        }),
      });
      const data = await res.json();
      if (data.refined) {
        onChange(data.refined);
        setShowRefine(false);
        setRefineText("");
      } else {
        setRefineError("Refinement failed — please try again");
      }
    } catch (e) {
      setRefineError("Network error — please try again");
    } finally {
      setRefining(false);
    }
  };

  return (
    <div style={{ marginBottom: 6 }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.07em" }}>{label}</span>
          {value.trim() && (
            <button
              onClick={() => { setShowRefine(v => !v); setRefineError(""); }}
              title="Refine this field with AI"
              style={{
                background: "none", border: "none", cursor: "pointer", padding: "1px 3px",
                fontSize: 11, opacity: hovered || showRefine ? 1 : 0,
                color: showRefine ? "#6366f1" : "#475569",
                transition: "opacity 0.15s, color 0.15s", lineHeight: 1,
              }}>✏</button>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {onPinChange && (
            <select value={pinValue} onChange={e => onPinChange(e.target.value)}
              style={{ fontSize: 10, padding: "2px 4px", border: "1px solid #334155", borderRadius: 4, background: "#1e293b", color: "#94a3b8", cursor: "pointer" }}>
              <option value="">No pin</option>
              <option value="1">Pin 1</option>
              <option value="2">Pin 2</option>
              {!isDesc && <option value="3">Pin 3</option>}
            </select>
          )}
          <span style={{ fontSize: 10, fontFamily: "monospace", fontWeight: 700, color, transition: "color 0.2s" }} title={grace ? "Slightly over — Google may still accept this" : ""}>
            {n}/{limit}{grace ? " ⚠" : ""}
          </span>
        </div>
      </div>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "7px 9px",
          background: over ? "rgba(255,77,77,0.08)" : "rgba(255,255,255,0.04)",
          border: `1.5px solid ${over ? "rgba(255,77,77,0.5)" : grace ? "rgba(245,158,11,0.55)" : warn ? "rgba(251,191,36,0.35)" : "rgba(255,255,255,0.08)"}`,
          borderRadius: 6,
          color: "#e2e8f0",
          fontSize: 12,
          fontFamily: mono ? "'IBM Plex Mono', monospace" : "inherit",
          outline: "none",
          boxSizing: "border-box",
          transition: "border-color 0.2s, background 0.2s",
        }}
        onFocus={e => { if (!over) e.target.style.borderColor = "rgba(99,102,241,0.6)"; }}
        onBlur={e => { e.target.style.borderColor = over ? "rgba(255,77,77,0.5)" : grace ? "rgba(245,158,11,0.55)" : warn ? "rgba(251,191,36,0.35)" : "rgba(255,255,255,0.08)"; }}
      />
      {showRefine && (
        <div style={{ marginTop: 5, padding: "8px 10px", background: "rgba(99,102,241,0.07)", border: "1px solid rgba(99,102,241,0.2)", borderRadius: 7 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              autoFocus
              value={refineText}
              onChange={e => setRefineText(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleRefine()}
              placeholder={isDesc ? "e.g. more urgent, add offer, shorter..." : "e.g. add keyword, more benefit-focused..."}
              style={{
                flex: 1, padding: "6px 8px", fontSize: 11,
                background: "rgba(255,255,255,0.05)", border: "1px solid rgba(99,102,241,0.25)",
                borderRadius: 6, color: "#e2e8f0", outline: "none", fontFamily: "inherit",
              }}
            />
            <button onClick={handleRefine} disabled={!refineText.trim() || refining} style={{
              padding: "6px 12px", fontSize: 11, fontWeight: 700, borderRadius: 6, border: "none",
              background: refining ? "rgba(99,102,241,0.2)" : "linear-gradient(135deg,#6366f1,#8b5cf6)",
              color: refining ? "#818cf8" : "white", cursor: refining ? "not-allowed" : "pointer",
              flexShrink: 0, display: "flex", alignItems: "center", gap: 5,
            }}>
              {refining ? <><span style={{ animation: "spin 0.8s linear infinite", display: "inline-block" }}>◌</span> Refining…</> : "✦ Refine"}
            </button>
          </div>
          {refineError && <div style={{ fontSize: 10, color: "#f87171", marginTop: 5 }}>{refineError}</div>}
        </div>
      )}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function RSAStudio() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState([makeRow(1)]);
  const [activeRow, setActiveRow] = useState(0);
  const [generated, setGenerated] = useState(false);
  const [pageMeta, setPageMeta] = useState({ language: "English" });
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState("headlines"); // headlines | descriptions | urls
  const [showGuide, setShowGuide] = useState(false);
  const [showCopyModal, setShowCopyModal] = useState(false);
  const [copiedNoGroup, setCopiedNoGroup] = useState(false);
  const [modalOmitGroup, setModalOmitGroup] = useState(false);
  const nextId = useRef(2);
  const [showGateModal, setShowGateModal] = useState(false);
  const [usageCount, setUsageCount] = useState(0);
  const [gateEmail, setGateEmail] = useState("");
  const [gateSubmitted, setGateSubmitted] = useState(false);
  const [sessionUrls, setSessionUrls] = useState([]);
  const [sessionLangs, setSessionLangs] = useState([]);
  const [keywords, setKeywords] = useState(["", "", ""]);
  const [kwHeadlines, setKwHeadlines] = useState(5);   // how many headlines should include keywords
  const [kwInDescs, setKwInDescs] = useState(false);   // toggle: include keywords in descriptions
  const [kwDescs, setKwDescs] = useState(1);           // how many descriptions

  // ── Ad Copy Modifiers ──────────────────────────────────────────────────────
  const [showModifiers, setShowModifiers] = useState(false);
  // Seasonal
  const [seasonOn, setSeasonOn] = useState(false);
  const [seasonPreset, setSeasonPreset] = useState("");
  const [seasonCustom, setSeasonCustom] = useState("");
  const [seasonIntensity, setSeasonIntensity] = useState("Moderate");
  // Discount
  const [discountOn, setDiscountOn] = useState(false);
  const [discountType, setDiscountType] = useState("% Off");
  const [discountValue, setDiscountValue] = useState("");
  const [discountPlacement, setDiscountPlacement] = useState("Both");
  // Brand & Compliance
  const [brandOn, setBrandOn] = useState(false);
  const [brandRequired, setBrandRequired] = useState("");
  const [brandBanned, setBrandBanned] = useState("");
  const [brandTone, setBrandTone] = useState("Professional");
  const [history, setHistory] = useState([]);          // last 5 generations
  const [showHistory, setShowHistory] = useState(false);

  const row = rows[activeRow];

  const updateRow = useCallback((idx, fn) =>
    setRows(prev => prev.map((r, i) => i === idx ? fn(r) : r)), []);

  const setField = (field, val) => updateRow(activeRow, r => ({ ...r, [field]: val }));
  const setHL = (i, key, val) => updateRow(activeRow, r => {
    const h = [...r.headlines]; h[i] = { ...h[i], [key]: val }; return { ...r, headlines: h };
  });
  const setDesc = (i, key, val) => updateRow(activeRow, r => {
    const d = [...r.descriptions]; d[i] = { ...d[i], [key]: val }; return { ...r, descriptions: d };
  });

  const generate = async () => {
    if (!url.trim()) { setError("Please enter a URL first"); return; }
    setLoading(true); setError("");
    try {
      // ── Step 0: Client-side URL language extraction (runs before scrape, immune to redirects) ──
      const urlLangCodes = { de: "German", fr: "French", it: "Italian", es: "Spanish", nl: "Dutch",
        pt: "Portuguese", pl: "Polish", sv: "Swedish", da: "Danish", fi: "Finnish",
        no: "Norwegian", nb: "Norwegian", cs: "Czech", hu: "Hungarian", ro: "Romanian" };
      const tldLangCodes = { dk: "Danish", se: "Swedish", no: "Norwegian", fi: "Finnish",
        de: "German", at: "German", fr: "French", it: "Italian", es: "Spanish",
        nl: "Dutch", pt: "Portuguese", pl: "Polish", cz: "Czech", hu: "Hungarian", ro: "Romanian" };
      const _pathMatch = url.match(/\/([a-z]{2})(?:-[a-z]{2})?\//);
      const urlPathLang = _pathMatch ? urlLangCodes[_pathMatch[1]?.toLowerCase()] || null : null;
      const urlTld = url.match(/\.([a-z]{2})(?:\/|$)/i)?.[1]?.toLowerCase();
      const tldFallbackLang = urlTld ? tldLangCodes[urlTld] || null : null;
      const clientLang = urlPathLang || tldFallbackLang || null;

      // ── Step 1: Scrape page metadata (language, meta description, title, OG tags) ──
      // clientLang from URL is used as guaranteed fallback if scrape fails or returns English
      let pageMeta = { language: clientLang || "English", title: null, metaDescription: null, siteName: null, h1: null };
      try {
        const scrapeRes = await fetch("/api/scrape", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        if (scrapeRes.ok) {
          const scraped = await scrapeRes.json();
          // Only use scraped language if it's non-English OR if we have no client-side signal
          const useScrapedLang = scraped.language && (scraped.language !== "English" || !clientLang);
          pageMeta = { ...pageMeta, ...scraped, language: useScrapedLang ? scraped.language : (clientLang || scraped.language || "English") };
          setPageMeta(pageMeta);
        }
      } catch (_) {
        // Scrape failed — continue with client-side language detection + empty metadata
      }

      // ── Step 2: Build context string from scraped metadata ──────────────────
      const metaContext = [
        pageMeta.title        && `Page title: ${pageMeta.title}`,
        pageMeta.siteName     && `Brand/site name: ${pageMeta.siteName}`,
        pageMeta.metaDescription && `Meta description: ${pageMeta.metaDescription}`,
        pageMeta.h1           && `Main page headline (H1): ${pageMeta.h1}`,
      ].filter(Boolean).join("\n");

      // ── Step 2b: Build keyword instructions ───────────────────────────────
      const activeKws = keywords.map(k => k.trim()).filter(Boolean);
      const kwInstruction = activeKws.length > 0 ? `
KEYWORDS TO INCLUDE:
Keywords pool: ${activeKws.join(", ")}
- Distribute these keywords naturally across exactly ${kwHeadlines} of the 15 headlines
- Treat the keywords as a pool — spread them across those ${kwHeadlines} headlines, some keywords may appear more than once if needed to fill the target
- A keyword may be the entire headline if it fits within 30 chars, or combined naturally with other words
- Do NOT force a keyword if it would cause the headline to exceed 30 characters — rephrase or use a shorter form${kwInDescs ? `
- Also include keywords naturally in ${kwDescs} of the 4 descriptions` : ""}
- Keywords must appear in the OUTPUT LANGUAGE — translate or adapt them if needed` : "";

      // ── Step 2c: Build modifier instructions ─────────────────────────────────
      const seasonLabel = seasonPreset === "Custom" ? seasonCustom.trim() : seasonPreset;
      const seasonInstruction = seasonOn && seasonLabel ? `
SEASONAL MODIFIER (${seasonIntensity} intensity):
- Weave "${seasonLabel}" seasonal messaging into the ad copy
- Subtle: 1-2 headlines reference the season; Moderate: 3-4 headlines + 1 description; Strong: 5+ headlines + all descriptions carry seasonal theme
- Keep seasonal language natural — do not force it where it doesn't fit` : "";

      const discountInstruction = discountOn && discountValue.trim() ? `
DISCOUNT/OFFER MODIFIER:
- Feature this offer prominently: "${discountValue.trim()} ${discountType}"
- Placement: ${discountPlacement === "Both" ? "Include in both headlines and descriptions" : discountPlacement === "Headlines only" ? "Include in headlines only" : "Include in descriptions only"}
- Lead with the offer where possible — it should be one of the first things users see` : "";

      const brandInstruction = brandOn && (brandRequired.trim() || brandBanned.trim()) ? `
BRAND & COMPLIANCE MODIFIER:
- Tone: ${brandTone}${brandRequired.trim() ? `
- REQUIRED words/phrases (must appear somewhere in the output): ${brandRequired.trim()}` : ""}${brandBanned.trim() ? `
- BANNED words/phrases (must NOT appear anywhere in the output): ${brandBanned.trim()}` : ""}` : "";

      const activeModifiers = [seasonOn && seasonLabel, discountOn && discountValue.trim(), brandOn && (brandRequired.trim() || brandBanned.trim())].filter(Boolean).length;
      const modifierWarning = activeModifiers >= 2 ? `
NOTE: ${activeModifiers} modifiers are active simultaneously. Balance them carefully — do not let any single modifier dominate the output at the expense of core product messaging.` : "";

      // ── Step 3: Generate ad copy with full context ───────────────────────────
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 2000,
          messages: [{
            role: "user",
            content: `You are a Google Ads expert. Generate RSA ad copy for this landing page.
CURRENT YEAR: ${new Date().getFullYear()} — always use this year for any seasonal or time-based references, never reference past years.

URL: ${url}

PAGE METADATA (use this as your primary source of truth for the product, brand and USPs):
${metaContext || "No metadata available — infer from the URL structure."}

OUTPUT LANGUAGE: ${pageMeta.language}
CRITICAL: You MUST write ALL headlines and descriptions in ${pageMeta.language}. 
Do not mix languages. Do not use English if the language is not English.

Return ONLY valid JSON — no prose, no markdown fences:
{
  "campaign": "short campaign name",
  "adGroup": "short ad group name",
  "headlines": ["h1","h2","h3","h4","h5","h6","h7","h8","h9","h10","h11","h12","h13","h14","h15"],
  "descriptions": ["d1","d2","d3","d4"],
  "path1": "short-path",
  "path2": "sub-path"
}

${kwInstruction}${seasonInstruction}${discountInstruction}${brandInstruction}${modifierWarning}

STRICT rules:
- Exactly 15 headlines, each ≤ ${HL_LIMIT} characters (hard limit)
- Exactly 4 descriptions, each ≤ ${DESC_LIMIT} characters (hard limit)
- path1 and path2: ≤ ${PATH_LIMIT} chars, no spaces, URL-safe
- Base ALL copy on the page metadata above — do not invent features not mentioned
- Vary headline types: brand, benefits, CTAs, features, social proof, urgency
- Descriptions: aim for 82-90 characters, complete sentences, never cut mid-word
- If a description fits in 91-93 chars with the final word included, include it
- If it would exceed 93 chars, rephrase to fit within 90 chars cleanly`
          }]
        })
      });
      const data = await res.json();

      // ── Check if usage gate has been hit ─────────────────────────────────
      if (data.gated) {
        setShowGateModal(true);
        setUsageCount(data.count || 10);
        return;
      }

      // Track usage count for the counter display
      if (data.usage_count) setUsageCount(data.usage_count);

      const text = data.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
      const rawJson = text.replace(/```json|```/g, "").trim().match(/\{[\s\S]*\}/)?.[0];
      if (!rawJson) throw new Error("Invalid response format");
      // Sanitise common issues: unescaped quotes inside string values, trailing commas
      const sanitised = rawJson
        .replace(/,\s*([\]}])/g, "$1")           // remove trailing commas before ] or }
        .replace(/[\u2018\u2019]/g, "'")          // curly single quotes → straight
        .replace(/[\u201c\u201d]/g, '"');         // curly double quotes → straight
      let p;
      try {
        p = JSON.parse(sanitised);
      } catch (e) {
        // Last resort: try to extract fields manually via regex
        const extractArr = (key) => {
          const m = sanitised.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`));
          if (!m) return [];
          return [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => x[1]);
        };
        const extractStr = (key) => sanitised.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`))?.[1] || "";
        p = {
          campaign: extractStr("campaign"),
          adGroup: extractStr("adGroup"),
          headlines: extractArr("headlines"),
          descriptions: extractArr("descriptions"),
          path1: extractStr("path1"),
          path2: extractStr("path2"),
        };
        if (p.headlines.length === 0) throw new Error("Could not parse response — please try again");
      }
      updateRow(activeRow, r => ({
        ...r,
        campaign: p.campaign || "",
        adGroup: p.adGroup || "",
        headlines: Array.from({ length: NUM_HL }, (_, i) => ({
          text: (p.headlines?.[i] || "").slice(0, HL_LIMIT), pin: ""
        })),
        descriptions: Array.from({ length: NUM_DESC }, (_, i) => ({
          text: smartTrimDesc(p.descriptions?.[i] || ""), pin: ""
        })),
        path1: (p.path1 || "").slice(0, PATH_LIMIT),
        path2: (p.path2 || "").slice(0, PATH_LIMIT),
        finalUrl: url,
      }));
      setGenerated(true);
      // Track session URLs and languages for lead capture
      setSessionUrls(prev => [...new Set([...prev, url])]);
      setSessionLangs(prev => [...new Set([...prev, pageMeta.language || "English"])]);
      // Save snapshot to history (keep last 5)
      setHistory(prev => {
        const snapshot = {
          id: Date.now(),
          url,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          rows: JSON.parse(JSON.stringify(rows.map((r, i) => i === activeRow ? {
            ...r,
            campaign: p.campaign || "",
            adGroup: p.adGroup || "",
            headlines: Array.from({ length: NUM_HL }, (_, j) => ({ text: (p.headlines?.[j] || "").slice(0, HL_LIMIT), pin: "" })),
            descriptions: Array.from({ length: NUM_DESC }, (_, j) => ({ text: smartTrimDesc(p.descriptions?.[j] || ""), pin: "" })),
            path1: (p.path1 || "").slice(0, PATH_LIMIT),
            path2: (p.path2 || "").slice(0, PATH_LIMIT),
            finalUrl: url,
          } : r))),
        };
        return [snapshot, ...prev].slice(0, 5);
      });
    } catch (e) {
      setError("Generation failed — " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const tsvText = buildTSV(rows, false);
  const tsvTextNoGroup = buildTSV(rows, true);

  // Shared copy logic — omitGroup=false: full data, omitGroup=true: no Campaign/Ad Group
  const triggerCopy = async (omitGroup) => {
    const text = omitGroup ? tsvTextNoGroup : tsvText;
    const setDone = omitGroup ? setCopiedNoGroup : setCopied;
    // Try native clipboard API first (works outside sandboxes)
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 2500);
      return;
    } catch (_) {}
    // Fallback: execCommand on a temporary textarea
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) { setDone(true); setTimeout(() => setDone(false), 2500); return; }
    } catch (_) {}
    // Both failed (sandboxed iframe) — show the manual copy modal
    setModalOmitGroup(omitGroup);
    setShowCopyModal(true);
  };

  const copyTSV = () => triggerCopy(false);
  const copyTSVNoGroup = () => triggerCopy(true);

  const downloadCSV = () => {
    const tsv = buildTSV(rows);
    const encoded = "data:text/tab-separated-values;charset=utf-8," + encodeURIComponent(tsv);
    const a = document.createElement("a");
    a.href = encoded;
    a.download = "rsa_ads.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const addAd = () => {
    const id = nextId.current++;
    setRows(prev => [...prev, makeRow(id)]);
    setActiveRow(rows.length);
    setGenerated(false);
  };

  const removeAd = (idx) => {
    if (rows.length === 1) return;
    setRows(prev => prev.filter((_, i) => i !== idx));
    setActiveRow(Math.max(0, Math.min(activeRow, rows.length - 2)));
  };

  const validH = row.headlines.filter(h => h.text.trim() && h.text.length <= HL_LIMIT).length;
  const validD = row.descriptions.filter(d => d.text.trim() && d.text.length <= DESC_LIMIT + DESC_GRACE).length;

  // ── Styles ──────────────────────────────────────────────────────────────────
  const S = {
    sectionLabel: { fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", textTransform: "uppercase", color: "#475569", marginBottom: 10, display: "block" },
    card: { background: "rgba(15,23,42,0.8)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12 },
    inputBase: {
      width: "100%", padding: "9px 12px",
      background: "rgba(255,255,255,0.04)",
      border: "1.5px solid rgba(255,255,255,0.1)",
      borderRadius: 8, color: "white", fontSize: 13,
      fontFamily: "'IBM Plex Mono', monospace",
      outline: "none", boxSizing: "border-box",
    },
  };


  // ── Gate Modal ───────────────────────────────────────────────────────────────
  const GateModal = () => {
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState("");

    const handleSubmit = async () => {
      if (!gateEmail.includes("@") || submitting) return;
      setSubmitting(true); setSubmitError("");
      try {
        await fetch("https://hooks.zapier.com/hooks/catch/4880947/u0332lz/", {
          method: "POST",
          mode: "no-cors", // Zapier webhooks don't return CORS headers
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: gateEmail,
            source: "RSA Studio — Free Tier Gate",
            urls_used: sessionUrls.join(", ") || "none recorded",
            languages_detected: sessionLangs.join(", ") || "English",
            generation_count: usageCount,
            timestamp: new Date().toISOString(),
            page_url: window.location.href,
          }),
        });
        // no-cors means we can't read the response — assume success
        setGateSubmitted(true);
      } catch (e) {
        setSubmitError("Something went wrong — please try again");
        setSubmitting(false);
      }
    };

    return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24,
    }}>
      <div style={{
        background: "linear-gradient(135deg,rgba(15,23,42,0.98),rgba(6,13,26,0.98))",
        border: "1px solid rgba(99,102,241,0.3)", borderRadius: 16,
        padding: "36px 32px", maxWidth: 440, width: "100%", textAlign: "center",
        boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
      }}>
        {!gateSubmitted ? (
          <>
            <div style={{ fontSize: 36, marginBottom: 12 }}>🚀</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#e2e8f0", marginBottom: 8 }}>
              You've used your 10 free generations
            </div>
            <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.6, marginBottom: 24 }}>
              Create a free account to keep generating high-quality RSA ad copy — no credit card required.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
              {["Unlimited generations", "Save & manage multiple ads", "Export to Google Ads Editor", "Priority support"].map(f => (
                <div key={f} style={{ display: "flex", alignItems: "center", gap: 10, textAlign: "left" }}>
                  <span style={{ color: "#34d399", fontSize: 14, flexShrink: 0 }}>✓</span>
                  <span style={{ fontSize: 13, color: "#94a3b8" }}>{f}</span>
                </div>
              ))}
            </div>
            <input
              type="email"
              value={gateEmail}
              onChange={e => setGateEmail(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSubmit()}
              placeholder="Enter your work email"
              style={{
                width: "100%", padding: "11px 14px", fontSize: 13,
                background: "rgba(255,255,255,0.06)", border: "1.5px solid rgba(255,255,255,0.12)",
                borderRadius: 8, color: "white", outline: "none", boxSizing: "border-box",
                marginBottom: 10, fontFamily: "inherit",
              }}
            />
            <button onClick={handleSubmit} disabled={!gateEmail.includes("@") || submitting}
              style={{
                width: "100%", padding: "12px", fontSize: 14, fontWeight: 800,
                background: gateEmail.includes("@") ? "linear-gradient(135deg,#3b82f6,#6366f1)" : "rgba(255,255,255,0.06)",
                color: gateEmail.includes("@") ? "white" : "#334155",
                border: "none", borderRadius: 8, cursor: gateEmail.includes("@") && !submitting ? "pointer" : "not-allowed",
                transition: "all 0.2s", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              }}>
              {submitting ? <><span style={{ animation: "spin 0.8s linear infinite", display: "inline-block" }}>◌</span> Sending…</> : "Create Free Account →"}
            </button>
            {submitError && <div style={{ fontSize: 11, color: "#f87171", marginBottom: 8 }}>{submitError}</div>}
            <div style={{ fontSize: 11, color: "#1e293b" }}>No credit card required · Takes 30 seconds</div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 36, marginBottom: 16 }}>🎉</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#e2e8f0", marginBottom: 8 }}>You're on the list!</div>
            <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.6, marginBottom: 20 }}>
              Thanks! We've received <strong style={{ color: "#94a3b8" }}>{gateEmail}</strong>. We'll be in touch shortly with your account details.
            </div>
            <div style={{ fontSize: 12, color: "#334155" }}>In the meantime, your current session will remain accessible.</div>
          </>
        )}
      </div>
    </div>
    );
  };

  // ── Copy Modal (sandbox fallback) ─────────────────────────────────────────
  const CopyModal = () => {
    const taRef = useRef(null);
    const [modalCopied, setModalCopied] = useState(false);

    const selectAll = () => {
      if (!taRef.current) return;
      taRef.current.focus();
      taRef.current.select();
      try {
        const ok = document.execCommand("copy");
        if (ok) { setModalCopied(true); setTimeout(() => setModalCopied(false), 2000); }
      } catch (_) {}
    };

    // Auto-select on open
    useState(() => { setTimeout(() => taRef.current?.select(), 80); });

    return (
      <div style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.75)", backdropFilter: "blur(4px)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }} onClick={e => { if (e.target === e.currentTarget) setShowCopyModal(false); }}>
        <div style={{
          background: "#0f172a", border: "1px solid rgba(99,102,241,0.4)",
          borderRadius: 14, padding: 24, width: "100%", maxWidth: 640,
          boxShadow: "0 25px 60px rgba(0,0,0,0.6)",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "white", marginBottom: 4 }}>
                {modalOmitGroup ? "Copy ad data — no campaign/group" : "Copy data for Google Ads Editor"}
              </div>
              <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>
                {modalOmitGroup && <span style={{display:"inline-block",marginBottom:4,padding:"2px 8px",borderRadius:4,background:"rgba(99,102,241,0.15)",color:"#a5b4fc",fontSize:11,fontWeight:700}}>Campaign &amp; Ad Group columns removed</span>}<br style={{display: modalOmitGroup ? "block" : "none"}} />
                The text below is pre-selected. Press <kbd style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 4, padding: "1px 6px", fontSize: 11, color: "#94a3b8" }}>Ctrl+C</kbd> (or <kbd style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 4, padding: "1px 6px", fontSize: 11, color: "#94a3b8" }}>⌘C</kbd>) to copy, then paste directly into Google Ads Editor.
              </div>
            </div>
            <button onClick={() => setShowCopyModal(false)} style={{
              background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 6, color: "#94a3b8", fontSize: 16, width: 30, height: 30,
              cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
            }}>✕</button>
          </div>

          <textarea
            ref={taRef}
            readOnly
            value={modalOmitGroup ? tsvTextNoGroup : tsvText}
            onClick={e => e.target.select()}
            style={{
              width: "100%", height: 160, padding: "10px 12px",
              background: "#020817", border: "1px solid rgba(99,102,241,0.3)",
              borderRadius: 8, color: "#a5b4fc", fontSize: 11,
              fontFamily: "'IBM Plex Mono', monospace", resize: "none",
              outline: "none", boxSizing: "border-box", lineHeight: 1.6,
            }}
          />

          <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
            <button onClick={selectAll} style={{
              flex: 1, padding: "10px 16px", fontSize: 13, fontWeight: 700,
              background: modalCopied ? "linear-gradient(135deg,#059669,#10b981)" : "linear-gradient(135deg,#3b82f6,#6366f1)",
              color: "white", border: "none", borderRadius: 8, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
              transition: "background 0.3s",
            }}>
              <span>{modalCopied ? "✓" : "📋"}</span>
              {modalCopied ? "Copied! Now paste into Ads Editor" : "Select All & Copy"}
            </button>
            <button onClick={() => setShowCopyModal(false)} style={{
              padding: "10px 16px", fontSize: 13, fontWeight: 700,
              background: "rgba(255,255,255,0.05)", color: "#64748b",
              border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, cursor: "pointer",
            }}>Close</button>
          </div>

          <div style={{ marginTop: 12, padding: "10px 12px", background: "rgba(59,130,246,0.07)", borderRadius: 8, border: "1px solid rgba(59,130,246,0.15)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#60a5fa", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Next steps in Google Ads Editor</div>
            {IMPORT_STEPS.map(s => (
              <div key={s.n} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 5 }}>
                <span style={{ fontSize: 10, fontWeight: 800, fontFamily: "monospace", color: "#3b82f6", background: "rgba(59,130,246,0.15)", borderRadius: 3, padding: "1px 5px", flexShrink: 0 }}>{s.n}</span>
                <span style={{ fontSize: 11, color: "#64748b", lineHeight: 1.4 }}>{s.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "#060d1a",
      backgroundImage: "radial-gradient(ellipse 80% 50% at 50% -10%, rgba(30,50,120,0.35), transparent), radial-gradient(ellipse 60% 40% at 80% 100%, rgba(20,80,60,0.2), transparent)",
      fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
      color: "#e2e8f0",
      display: "flex",
      flexDirection: "column",
      minHeight: "100vh",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,700;0,800;1,400&family=IBM+Plex+Mono:wght@400;600;700&display=swap" rel="stylesheet" />

      {/* ── Top Bar ── */}
      <div style={{
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        padding: "14px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        background: "rgba(6,13,26,0.9)",
        backdropFilter: "blur(12px)",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: "linear-gradient(135deg, #3b82f6, #06b6d4)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 16, fontWeight: 900, color: "white",
          }}>G</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "white", letterSpacing: "-0.01em" }}>RSA Studio</div>
            <div style={{ fontSize: 10, color: "#475569", letterSpacing: "0.06em" }}>GOOGLE ADS EDITOR READY</div>
          </div>
        </div>

        {/* Ad tabs */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {rows.map((r, i) => (
            <div key={r.id} style={{ display: "flex" }}>
              <button onClick={() => setActiveRow(i)} style={{
                padding: "5px 12px", fontSize: 11, fontWeight: 700,
                background: activeRow === i ? "rgba(59,130,246,0.2)" : "transparent",
                color: activeRow === i ? "#60a5fa" : "#475569",
                border: activeRow === i ? "1px solid rgba(59,130,246,0.35)" : "1px solid rgba(255,255,255,0.06)",
                borderRadius: rows.length > 1 ? "6px 0 0 6px" : "6px",
                cursor: "pointer", letterSpacing: "0.04em",
              }}>
                Ad {i + 1}{r.campaign ? ` · ${r.campaign.slice(0, 10)}` : ""}
              </button>
              {rows.length > 1 && (
                <button onClick={() => removeAd(i)} style={{
                  padding: "5px 8px", fontSize: 10,
                  background: "rgba(239,68,68,0.1)", color: "#f87171",
                  border: "1px solid rgba(239,68,68,0.2)", borderLeft: "none",
                  borderRadius: "0 6px 6px 0", cursor: "pointer",
                }}>✕</button>
              )}
            </div>
          ))}
          <button onClick={addAd} style={{
            padding: "5px 10px", fontSize: 11, fontWeight: 700,
            background: "transparent", color: "#475569",
            border: "1px dashed rgba(255,255,255,0.12)", borderRadius: 6, cursor: "pointer",
          }}>+ Ad</button>
        </div>

        {/* Export buttons */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
            <button onClick={copyTSV} style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "7px 16px", fontSize: 12, fontWeight: 700,
              background: copied ? "linear-gradient(135deg,#059669,#10b981)" : "linear-gradient(135deg,#3b82f6,#06b6d4)",
              color: "white", border: "none", borderRadius: 7, cursor: "pointer",
              transition: "all 0.3s",
            }}>
              {copied ? "✓ Copied!" : "📋 Copy for Editor"}
            </button>
            <button onClick={copyTSVNoGroup} style={{
              background: "none", border: "none", cursor: "pointer",
              fontSize: 10, color: copiedNoGroup ? "#34d399" : "#e2e8f0",
              textDecoration: "underline", textDecorationStyle: "dotted",
              letterSpacing: "0.02em", padding: "0 2px",
              transition: "color 0.2s",
            }}>
              {copiedNoGroup ? "✓ copied!" : "copy without campaign/ad group"}
            </button>
          </div>
          <button onClick={downloadCSV} style={{
            padding: "7px 14px", fontSize: 12, fontWeight: 700,
            background: "rgba(255,255,255,0.06)",
            color: "#94a3b8", border: "1px solid rgba(255,255,255,0.09)",
            borderRadius: 7, cursor: "pointer",
          }}>⬇ CSV</button>
        </div>
      </div>

      {/* ── URL Bar ── */}
      <div style={{ padding: "16px 24px", borderBottom: "1px solid rgba(255,255,255,0.05)", background: "rgba(6,13,26,0.6)" }}>
        <div style={{ maxWidth: 900, margin: "0 auto", display: "flex", gap: 10 }}>
          <div style={{ flex: 1, position: "relative" }}>
            <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "#475569", fontSize: 13 }}>🔗</span>
            <input
              type="url"
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => e.key === "Enter" && generate()}
              placeholder="https://yoursite.com/landing-page → press Enter or click Generate"
              style={{ ...S.inputBase, paddingLeft: 34, fontSize: 13 }}
            />
          </div>
          <button onClick={generate} disabled={loading} style={{
            padding: "9px 22px", fontSize: 13, fontWeight: 700,
            background: loading ? "rgba(59,130,246,0.2)" : "linear-gradient(135deg,#3b82f6,#6366f1)",
            color: loading ? "#60a5fa" : "white", border: "none",
            borderRadius: 8, cursor: loading ? "not-allowed" : "pointer",
            display: "flex", alignItems: "center", gap: 7, flexShrink: 0,
            transition: "all 0.2s",
          }}>
            {loading ? <><span style={{ animation: "spin 0.8s linear infinite", display: "inline-block", fontSize: 16 }}>◌</span> Analyzing…</> : "✦ Generate"}
          </button>
          {generated && !loading && (
            <button onClick={() => {
              setUrl("");
              setKeywords(["", "", ""]);
              setKwHeadlines(5);
              setKwInDescs(false);
              setKwDescs(1);
              setRows([makeRow(1)]);
              setActiveRow(0);
              setGenerated(false);
              setError("");
              setActiveTab("headlines");
            }} style={{
              padding: "9px 14px", fontSize: 11, fontWeight: 700,
              background: "rgba(255,255,255,0.05)",
              color: "#64748b", border: "1px solid rgba(255,255,255,0.09)",
              borderRadius: 8, cursor: "pointer", flexShrink: 0,
              transition: "all 0.2s", whiteSpace: "nowrap",
            }}>↺ Clear & new URL</button>
          )}
        </div>
        {error && (
          <div style={{ maxWidth: 900, margin: "8px auto 0", fontSize: 12, color: "#f87171", display: "flex", alignItems: "center", gap: 6 }}>
            <span>⚠</span> {error}
          </div>
        )}
        {usageCount > 0 && !showGateModal && (
          <div style={{ maxWidth: 900, margin: "6px auto 0", display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${(usageCount / 10) * 100}%`, height: "100%", background: usageCount >= 8 ? "linear-gradient(90deg,#f59e0b,#ef4444)" : "linear-gradient(90deg,#3b82f6,#6366f1)", borderRadius: 2, transition: "width 0.4s" }} />
            </div>
            <span style={{ fontSize: 10, color: usageCount >= 8 ? "#f59e0b" : "#334155", fontWeight: 700, whiteSpace: "nowrap" }}>
              {usageCount}/10 free generations{usageCount >= 8 ? " — almost at limit" : ""}
            </span>
          </div>
        )}
      </div>

      {/* ── Main 2-Col Layout ── */}
      <div style={{ flex: 1, display: "flex", gap: 0, overflow: "hidden", maxHeight: "calc(100vh - 160px)" }}>

        {/* LEFT: Edit Panel */}
        <div style={{
          width: 380, flexShrink: 0,
          borderRight: "1px solid rgba(255,255,255,0.06)",
          overflowY: "auto", padding: "20px 20px",
          background: "rgba(6,13,26,0.4)",
        }}>

          {/* Campaign / Ad Group */}
          <div style={{ marginBottom: 20 }}>
            <span style={S.sectionLabel}>Targeting</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <div style={{ fontSize: 10, color: "#475569", fontWeight: 700, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>Campaign</div>
                <input value={row.campaign} onChange={e => setField("campaign", e.target.value)} placeholder="My Campaign" style={{ ...S.inputBase, fontSize: 12 }} />
              </div>
              <div>
                <div style={{ fontSize: 10, color: "#475569", fontWeight: 700, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>Ad Group</div>
                <input value={row.adGroup} onChange={e => setField("adGroup", e.target.value)} placeholder="My Ad Group" style={{ ...S.inputBase, fontSize: 12 }} />
              </div>
            </div>
          </div>

          {/* Keywords section */}
          <div style={{ marginBottom: 20 }}>
            <span style={S.sectionLabel}>Keywords</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
              {keywords.map((kw, i) => (
                <div key={i} style={{ position: "relative" }}>
                  <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", fontSize: 9, fontWeight: 800, color: "#334155", fontFamily: "monospace" }}>K{i+1}</span>
                  <input
                    value={kw}
                    onChange={e => setKeywords(prev => prev.map((k, j) => j === i ? e.target.value : k))}
                    placeholder={i === 0 ? "Primary keyword (optional)" : i === 1 ? "Secondary keyword (optional)" : "Third keyword (optional)"}
                    style={{ ...S.inputBase, fontSize: 12, paddingLeft: 28 }}
                  />
                </div>
              ))}
            </div>
            {keywords.some(k => k.trim()) && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {/* Headline distribution */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.06em" }}>Headlines with keywords</div>
                    <div style={{ fontSize: 9, color: "#334155", marginTop: 1 }}>Google recommends 3–5</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <button onClick={() => setKwHeadlines(v => Math.max(1, v - 1))} style={{ width: 22, height: 22, borderRadius: 4, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#94a3b8", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                    <span style={{ fontSize: 13, fontWeight: 800, color: "#e2e8f0", fontFamily: "monospace", minWidth: 20, textAlign: "center" }}>{kwHeadlines}</span>
                    <button onClick={() => setKwHeadlines(v => Math.min(10, v + 1))} style={{ width: 22, height: 22, borderRadius: 4, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#94a3b8", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                  </div>
                </div>
                {/* Description toggle */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: "0.06em" }}>Include in descriptions</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {kwInDescs && (
                      <>
                        <button onClick={() => setKwDescs(v => Math.max(1, v - 1))} style={{ width: 22, height: 22, borderRadius: 4, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#94a3b8", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                        <span style={{ fontSize: 13, fontWeight: 800, color: "#e2e8f0", fontFamily: "monospace", minWidth: 20, textAlign: "center" }}>{kwDescs}</span>
                        <button onClick={() => setKwDescs(v => Math.min(4, v + 1))} style={{ width: 22, height: 22, borderRadius: 4, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#94a3b8", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                      </>
                    )}
                    <button onClick={() => setKwInDescs(v => !v)} style={{
                      width: 36, height: 20, borderRadius: 10, border: "none", cursor: "pointer",
                      background: kwInDescs ? "linear-gradient(135deg,#3b82f6,#6366f1)" : "rgba(255,255,255,0.08)",
                      position: "relative", transition: "background 0.2s", flexShrink: 0,
                    }}>
                      <span style={{
                        position: "absolute", top: 2, left: kwInDescs ? 18 : 2,
                        width: 16, height: 16, borderRadius: "50%", background: "white",
                        transition: "left 0.2s", display: "block",
                      }} />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Ad Copy Modifiers accordion */}
          <div style={{ marginBottom: 20 }}>
            <button onClick={() => setShowModifiers(v => !v)} style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
              background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: 8, padding: "8px 12px", cursor: "pointer", marginBottom: showModifiers ? 10 : 0,
              transition: "margin 0.2s",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", textTransform: "uppercase", color: "#475569" }}>Ad Copy Modifiers</span>
                {[seasonOn, discountOn, brandOn].filter(Boolean).length > 0 && (
                  <span style={{ fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 10, background: "rgba(99,102,241,0.2)", color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.3)" }}>
                    {[seasonOn, discountOn, brandOn].filter(Boolean).length} active
                  </span>
                )}
              </div>
              <span style={{ fontSize: 10, color: "#334155" }}>{showModifiers ? "▲" : "▼"}</span>
            </button>

            {showModifiers && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>

                {/* Multi-modifier warning */}
                {[seasonOn, discountOn, brandOn].filter(Boolean).length >= 2 && (
                  <div style={{ padding: "7px 10px", borderRadius: 7, background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.2)", fontSize: 11, color: "#fbbf24", lineHeight: 1.4 }}>
                    ⚠ {[seasonOn, discountOn, brandOn].filter(Boolean).length} modifiers active — results may vary
                  </div>
                )}

                {/* ── Seasonal Messaging ── */}
                <div style={{ borderRadius: 8, border: "1px solid rgba(255,255,255,0.07)", overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", background: "rgba(255,255,255,0.03)" }}>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: seasonOn ? "#e2e8f0" : "#475569" }}>🗓 Seasonal Messaging</div>
                      {seasonOn && seasonPreset && seasonPreset !== "Custom" && <div style={{ fontSize: 9, color: "#6366f1", marginTop: 1 }}>{seasonPreset} · {seasonIntensity}</div>}
                    </div>
                    <button onClick={() => setSeasonOn(v => !v)} style={{ ...({width: 36, height: 20, borderRadius: 10, border: "none", cursor: "pointer", position: "relative", transition: "background 0.2s", flexShrink: 0}), background: seasonOn ? "linear-gradient(135deg,#6366f1,#8b5cf6)" : "rgba(255,255,255,0.08)" }}>
                      <span style={{ ...({position: "absolute", top: 2, width: 16, height: 16, borderRadius: "50%", background: "white", transition: "left 0.2s", display: "block"}), left: seasonOn ? 18 : 2 }} />
                    </button>
                  </div>
                  {seasonOn && (
                    <div style={{ padding: "10px 12px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                        {["Black Friday", "Christmas", "New Year", "Valentine's", "Easter", "Summer Sale", "Back to School", "Custom"].map(p => (
                          <button key={p} onClick={() => setSeasonPreset(p)} style={{
                            padding: "4px 9px", fontSize: 10, fontWeight: 700, borderRadius: 20, cursor: "pointer",
                            background: seasonPreset === p ? "rgba(99,102,241,0.25)" : "rgba(255,255,255,0.04)",
                            color: seasonPreset === p ? "#a5b4fc" : "#475569",
                            border: `1px solid ${seasonPreset === p ? "rgba(99,102,241,0.4)" : "rgba(255,255,255,0.07)"}`,
                            transition: "all 0.15s",
                          }}>{p}</button>
                        ))}
                      </div>
                      {seasonPreset === "Custom" && (
                        <input value={seasonCustom} onChange={e => setSeasonCustom(e.target.value)}
                          placeholder="e.g. Spring Launch, Cyber Monday..."
                          style={{ ...S.inputBase, fontSize: 12 }} />
                      )}
                      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ fontSize: 10, color: "#475569", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", flexShrink: 0 }}>Intensity</span>
                        {["Subtle", "Moderate", "Strong"].map(level => (
                          <button key={level} onClick={() => setSeasonIntensity(level)} style={{
                            flex: 1, padding: "4px 6px", fontSize: 10, fontWeight: 700, borderRadius: 5, cursor: "pointer",
                            background: seasonIntensity === level ? "rgba(99,102,241,0.2)" : "rgba(255,255,255,0.03)",
                            color: seasonIntensity === level ? "#a5b4fc" : "#334155",
                            border: `1px solid ${seasonIntensity === level ? "rgba(99,102,241,0.35)" : "rgba(255,255,255,0.06)"}`,
                          }}>{level}</button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* ── Discount & Offer ── */}
                <div style={{ borderRadius: 8, border: "1px solid rgba(255,255,255,0.07)", overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", background: "rgba(255,255,255,0.03)" }}>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: discountOn ? "#e2e8f0" : "#475569" }}>🏷 Discount & Offer</div>
                      {discountOn && discountValue && <div style={{ fontSize: 9, color: "#34d399", marginTop: 1 }}>{discountValue} {discountType} · {discountPlacement}</div>}
                    </div>
                    <button onClick={() => setDiscountOn(v => !v)} style={{ ...({width: 36, height: 20, borderRadius: 10, border: "none", cursor: "pointer", position: "relative", transition: "background 0.2s", flexShrink: 0}), background: discountOn ? "linear-gradient(135deg,#059669,#10b981)" : "rgba(255,255,255,0.08)" }}>
                      <span style={{ ...({position: "absolute", top: 2, width: 16, height: 16, borderRadius: "50%", background: "white", transition: "left 0.2s", display: "block"}), left: discountOn ? 18 : 2 }} />
                    </button>
                  </div>
                  {discountOn && (
                    <div style={{ padding: "10px 12px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", gap: 6 }}>
                        <input value={discountValue} onChange={e => setDiscountValue(e.target.value)}
                          placeholder="e.g. 20, Free, 50kr"
                          style={{ ...S.inputBase, fontSize: 12, flex: 1 }} />
                        <select value={discountType} onChange={e => setDiscountType(e.target.value)} style={{
                          padding: "8px 8px", fontSize: 11, fontWeight: 700,
                          background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)",
                          borderRadius: 8, color: "#94a3b8", cursor: "pointer", flexShrink: 0,
                        }}>
                          {["% Off", "Fixed Amount", "Free Shipping", "Free Trial", "Custom"].map(t => <option key={t}>{t}</option>)}
                        </select>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ fontSize: 10, color: "#475569", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", flexShrink: 0 }}>Placement</span>
                        {["Headlines only", "Descriptions only", "Both"].map(p => (
                          <button key={p} onClick={() => setDiscountPlacement(p)} style={{
                            flex: 1, padding: "4px 4px", fontSize: 9, fontWeight: 700, borderRadius: 5, cursor: "pointer",
                            background: discountPlacement === p ? "rgba(16,185,129,0.15)" : "rgba(255,255,255,0.03)",
                            color: discountPlacement === p ? "#34d399" : "#334155",
                            border: `1px solid ${discountPlacement === p ? "rgba(16,185,129,0.3)" : "rgba(255,255,255,0.06)"}`,
                          }}>{p}</button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* ── Brand & Compliance ── */}
                <div style={{ borderRadius: 8, border: "1px solid rgba(255,255,255,0.07)", overflow: "hidden" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", background: "rgba(255,255,255,0.03)" }}>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: brandOn ? "#e2e8f0" : "#475569" }}>✓ Brand & Compliance</div>
                      {brandOn && <div style={{ fontSize: 9, color: "#f59e0b", marginTop: 1 }}>{brandTone} tone{brandRequired ? " · required terms set" : ""}{brandBanned ? " · banned terms set" : ""}</div>}
                    </div>
                    <button onClick={() => setBrandOn(v => !v)} style={{ ...({width: 36, height: 20, borderRadius: 10, border: "none", cursor: "pointer", position: "relative", transition: "background 0.2s", flexShrink: 0}), background: brandOn ? "linear-gradient(135deg,#d97706,#f59e0b)" : "rgba(255,255,255,0.08)" }}>
                      <span style={{ ...({position: "absolute", top: 2, width: 16, height: 16, borderRadius: "50%", background: "white", transition: "left 0.2s", display: "block"}), left: brandOn ? 18 : 2 }} />
                    </button>
                  </div>
                  {brandOn && (
                    <div style={{ padding: "10px 12px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
                        <span style={{ fontSize: 10, color: "#475569", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", flexShrink: 0 }}>Tone</span>
                        {["Professional", "Friendly", "Urgent", "Neutral"].map(t => (
                          <button key={t} onClick={() => setBrandTone(t)} style={{
                            flex: 1, padding: "4px 4px", fontSize: 9, fontWeight: 700, borderRadius: 5, cursor: "pointer",
                            background: brandTone === t ? "rgba(245,158,11,0.15)" : "rgba(255,255,255,0.03)",
                            color: brandTone === t ? "#f59e0b" : "#334155",
                            border: `1px solid ${brandTone === t ? "rgba(245,158,11,0.3)" : "rgba(255,255,255,0.06)"}`,
                          }}>{t}</button>
                        ))}
                      </div>
                      <div>
                        <div style={{ fontSize: 10, color: "#34d399", fontWeight: 700, marginBottom: 4 }}>✓ Required phrases</div>
                        <textarea value={brandRequired} onChange={e => setBrandRequired(e.target.value)}
                          placeholder="e.g. Official dealer, Award-winning, ISO certified"
                          rows={2} style={{ ...S.inputBase, fontSize: 11, resize: "none", height: 52, lineHeight: 1.4 }} />
                      </div>
                      <div>
                        <div style={{ fontSize: 10, color: "#f87171", fontWeight: 700, marginBottom: 4 }}>✗ Banned phrases</div>
                        <textarea value={brandBanned} onChange={e => setBrandBanned(e.target.value)}
                          placeholder="e.g. Cheap, Guaranteed, #1 in the world"
                          rows={2} style={{ ...S.inputBase, fontSize: 11, resize: "none", height: 52, lineHeight: 1.4 }} />
                      </div>
                    </div>
                  )}
                </div>

              </div>
            )}
          </div>

          {/* Tab nav */}
          <div style={{ display: "flex", marginBottom: 14, background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: 3 }}>
            {[
              { id: "headlines", label: `Headlines ${validH}/${NUM_HL}` },
              { id: "descriptions", label: `Desc ${validD}/${NUM_DESC}` },
              { id: "urls", label: "URLs" },
            ].map(t => (
              <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
                flex: 1, padding: "6px 4px", fontSize: 10.5, fontWeight: 700,
                background: activeTab === t.id ? "rgba(59,130,246,0.25)" : "transparent",
                color: activeTab === t.id ? "#60a5fa" : "#475569",
                border: "none", borderRadius: 6, cursor: "pointer",
                letterSpacing: "0.04em", transition: "all 0.15s",
              }}>{t.label}</button>
            ))}
          </div>

          {/* Fields */}
          {activeTab === "headlines" && (
            <>
              <span style={S.sectionLabel}>Headlines — 30 char max each</span>
              {row.headlines.map((h, i) => (
                <EditableField
                  key={i}
                  label={`H${i + 1}`}
                  value={h.text}
                  limit={HL_LIMIT}
                  onChange={v => setHL(i, "text", v)}
                  pinValue={h.pin}
                  onPinChange={v => setHL(i, "pin", v)}
                  refineContext={{ url, language: pageMeta?.language || "English" }}
                />
              ))}
            </>
          )}

          {activeTab === "descriptions" && (
            <>
              <span style={S.sectionLabel}>Descriptions — 90 char max each</span>
              {row.descriptions.map((d, i) => (
                <EditableField
                  key={i}
                  label={`D${i + 1}`}
                  value={d.text}
                  limit={DESC_LIMIT}
                  onChange={v => setDesc(i, "text", v)}
                  pinValue={d.pin}
                  onPinChange={v => setDesc(i, "pin", v)}
                  isDesc={true}
                  refineContext={{ url, language: pageMeta?.language || "English" }}
                />
              ))}
            </>
          )}

          {activeTab === "urls" && (
            <>
              <span style={S.sectionLabel}>URLs & Display Paths</span>
              <EditableField label="Final URL" value={row.finalUrl} limit={2048} onChange={v => setField("finalUrl", v)} mono />
              <EditableField label="Path 1" value={row.path1} limit={PATH_LIMIT} onChange={v => setField("path1", v)} mono />
              <EditableField label="Path 2" value={row.path2} limit={PATH_LIMIT} onChange={v => setField("path2", v)} mono />
            </>
          )}
        </div>

        {/* RIGHT: Preview Panel */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Ad Strength + Score */}
          <div style={{ ...S.card, padding: "18px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
            <div>
              <span style={S.sectionLabel}>Ad Strength</span>
              <AdStrengthRing headlines={row.headlines} descriptions={row.descriptions} />
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <span style={S.sectionLabel}>Quick stats</span>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {[
                  { label: "Headlines", val: `${validH}/${NUM_HL}`, ok: validH >= NUM_HL },
                  { label: "Descriptions", val: `${validD}/${NUM_DESC}`, ok: validD >= NUM_DESC },
                  { label: "Over char limit", val: [...row.headlines, ...row.descriptions].filter(f => f.text.length > (f.pin !== undefined ? HL_LIMIT : DESC_LIMIT)).length, ok: false },
                  { label: "Final URL set", val: row.finalUrl ? "Yes" : "No", ok: !!row.finalUrl },
                ].map(stat => (
                  <div key={stat.label} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 7, padding: "8px 10px" }}>
                    <div style={{ fontSize: 10, color: "#475569", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{stat.label}</div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: stat.ok ? "#34d399" : "#e2e8f0" }}>{stat.val}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* SERP Preview */}
          <div style={S.card}>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ ...S.sectionLabel, margin: 0 }}>Google SERP Preview</span>
              <span style={{ fontSize: 10, color: "#334155", fontStyle: "italic" }}>Shows first 3 headlines · first 2 descriptions</span>
            </div>
            <div style={{ padding: "18px" }}>
              <SerpPreview row={row} />
            </div>
            {/* Headline rotation hint */}
            {row.headlines.filter(h => h.text.trim()).length > 3 && (
              <div style={{ padding: "0 18px 14px", fontSize: 11, color: "#334155", display: "flex", alignItems: "center", gap: 5 }}>
                <span>⟳</span> Google will rotate all {row.headlines.filter(h => h.text.trim()).length} headlines automatically
              </div>
            )}
          </div>

          {/* All Headlines grid preview */}
          {generated && (
            <div style={S.card}>
              <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                <span style={{ ...S.sectionLabel, margin: 0 }}>All Headlines</span>
              </div>
              <div style={{ padding: "14px 18px", display: "flex", flexWrap: "wrap", gap: 6 }}>
                {row.headlines.map((h, i) => {
                  const { over, warn } = charInfo(h.text, HL_LIMIT);
                  return h.text ? (
                    <div key={i} style={{
                      padding: "4px 10px", borderRadius: 20, fontSize: 12,
                      background: over ? "rgba(239,68,68,0.12)" : warn ? "rgba(251,191,36,0.1)" : "rgba(59,130,246,0.1)",
                      border: `1px solid ${over ? "rgba(239,68,68,0.3)" : warn ? "rgba(251,191,36,0.25)" : "rgba(59,130,246,0.2)"}`,
                      color: over ? "#f87171" : warn ? "#fbbf24" : "#93c5fd",
                      display: "flex", alignItems: "center", gap: 5,
                    }}>
                      <span style={{ fontSize: 9, opacity: 0.5 }}>H{i + 1}</span>
                      {h.text}
                      {h.pin && <span style={{ fontSize: 9, background: "rgba(99,102,241,0.3)", borderRadius: 3, padding: "1px 4px", color: "#a5b4fc" }}>📌{h.pin}</span>}
                    </div>
                  ) : null;
                })}
              </div>

              {/* Descriptions */}
              <div style={{ padding: "0 18px 14px", borderTop: "1px solid rgba(255,255,255,0.04)", paddingTop: 12 }}>
                <span style={{ ...S.sectionLabel }}>All Descriptions</span>
                {row.descriptions.map((d, i) => {
                  const { over, warn } = charInfo(d.text, DESC_LIMIT);
                  return d.text ? (
                    <div key={i} style={{
                      padding: "7px 10px", borderRadius: 7, fontSize: 12,
                      marginBottom: 5, lineHeight: 1.4,
                      background: over ? "rgba(239,68,68,0.08)" : "rgba(255,255,255,0.03)",
                      border: `1px solid ${over ? "rgba(239,68,68,0.25)" : "rgba(255,255,255,0.06)"}`,
                      color: over ? "#f87171" : "#94a3b8",
                      display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8,
                    }}>
                      <span style={{ color: "#475569", fontSize: 10, flexShrink: 0, marginTop: 1 }}>D{i + 1}</span>
                      <span style={{ flex: 1 }}>{d.text}</span>
                      <span style={{ fontSize: 10, fontFamily: "monospace", color: charInfo(d.text, DESC_LIMIT, true).color, flexShrink: 0 }} title={charInfo(d.text, DESC_LIMIT, true).grace ? "Slightly over — tolerated" : ""}>{d.text.length}{charInfo(d.text, DESC_LIMIT, true).grace ? "⚠" : ""}</span>
                    </div>
                  ) : null;
                })}
              </div>
            </div>
          )}

          {/* History panel */}
          {history.length > 0 && (
            <div style={S.card}>
              <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ ...S.sectionLabel, margin: 0 }}>Recent Generations</span>
                <button onClick={() => setShowHistory(!showHistory)} style={{
                  fontSize: 11, fontWeight: 700, color: "#475569",
                  background: "none", border: "none", cursor: "pointer", letterSpacing: "0.04em",
                }}>{showHistory ? "▲ Hide" : `▼ Show (${history.length})`}</button>
              </div>
              {showHistory && (
                <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                  {history.map((h, i) => (
                    <div key={h.id} style={{
                      padding: "10px 12px", borderRadius: 8,
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.07)",
                      display: "flex", alignItems: "center", gap: 10,
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#e2e8f0", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {h.rows[0]?.campaign || new URL(h.url).hostname}
                        </div>
                        <div style={{ fontSize: 10, color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.url}</div>
                        <div style={{ fontSize: 9, color: "#1e293b", marginTop: 2 }}>{h.timestamp} · {h.rows[0]?.headlines.filter(hl => hl.text).length} headlines</div>
                      </div>
                      <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
                        <button onClick={() => {
                          setRows(h.rows);
                          setActiveRow(0);
                          setUrl(h.url);
                          setGenerated(true);
                          setShowHistory(false);
                        }} style={{
                          padding: "5px 10px", fontSize: 11, fontWeight: 700,
                          background: "rgba(59,130,246,0.15)", color: "#60a5fa",
                          border: "1px solid rgba(59,130,246,0.25)", borderRadius: 6, cursor: "pointer",
                        }}>Load</button>
                        <button onClick={() => {
                          const tsv = buildTSV(h.rows, false);
                          navigator.clipboard.writeText(tsv).catch(() => {});
                        }} style={{
                          padding: "5px 10px", fontSize: 11, fontWeight: 700,
                          background: "rgba(255,255,255,0.05)", color: "#64748b",
                          border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, cursor: "pointer",
                        }}>TSV</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Export + Guide */}
          <div style={S.card}>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ ...S.sectionLabel, margin: 0 }}>Export to Google Ads Editor</span>
              <button onClick={() => setShowGuide(!showGuide)} style={{
                fontSize: 11, fontWeight: 700, color: "#475569",
                background: "none", border: "none", cursor: "pointer", letterSpacing: "0.04em",
              }}>{showGuide ? "▲ Hide guide" : "▼ Show import guide"}</button>
            </div>

            <div style={{ padding: "14px 18px" }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
                <div style={{ flex: 1, minWidth: 160, display: "flex", flexDirection: "column", gap: 5 }}>
                  <button onClick={copyTSV} style={{
                    width: "100%", padding: "11px 16px", fontSize: 13, fontWeight: 700,
                    background: copied ? "linear-gradient(135deg,#059669,#10b981)" : "linear-gradient(135deg,#3b82f6,#06b6d4)",
                    color: "white", border: "none", borderRadius: 8, cursor: "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                    transition: "all 0.3s", boxShadow: copied ? "0 0 20px rgba(16,185,129,0.3)" : "0 0 20px rgba(59,130,246,0.2)",
                  }}>
                    <span style={{ fontSize: 16 }}>{copied ? "✓" : "📋"}</span>
                    {copied ? "Copied to clipboard!" : "Copy for Google Ads Editor"}
                  </button>
                  <button onClick={copyTSVNoGroup} style={{
                    background: "none", border: "none", cursor: "pointer",
                    fontSize: 11, color: copiedNoGroup ? "#34d399" : "#e2e8f0",
                    textDecoration: "underline", textDecorationStyle: "dotted",
                    letterSpacing: "0.02em", textAlign: "center", padding: "2px 0",
                    transition: "color 0.2s",
                  }}>
                    {copiedNoGroup ? "✓ copied without campaign/ad group!" : "copy without campaign / ad group"}
                  </button>
                </div>
                <button onClick={downloadCSV} style={{
                  padding: "11px 16px", fontSize: 13, fontWeight: 700,
                  background: "rgba(255,255,255,0.05)", color: "#64748b",
                  border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 6,
                }}>
                  ⬇ Download CSV
                </button>
              </div>

              {/* TSV mini-preview */}
              <div style={{ background: "rgba(0,0,0,0.3)", borderRadius: 7, padding: "10px 12px", overflowX: "auto" }}>
                <div style={{ fontSize: 9, color: "#334155", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>TSV preview — {rows.length} ad{rows.length > 1 ? "s" : ""}</div>
                <table style={{ borderCollapse: "collapse", fontSize: 10, fontFamily: "monospace", color: "#64748b", whiteSpace: "nowrap" }}>
                  <thead>
                    <tr>{["Campaign", "Ad Group", "Headline 1", "Headline 2", "Headline 3", `+${TSV_HEADERS.length - 5} cols`].map(h =>
                      <td key={h} style={{ padding: "2px 12px 2px 0", color: "#3b82f6", fontWeight: 700 }}>{h}</td>)}</tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.id}>
                        <td style={{ padding: "2px 12px 2px 0" }}>{r.campaign || "—"}</td>
                        <td style={{ padding: "2px 12px 2px 0" }}>{r.adGroup || "—"}</td>
                        {r.headlines.slice(0, 3).map((h, i) => (
                          <td key={i} style={{ padding: "2px 12px 2px 0", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>{h.text || "—"}</td>
                        ))}
                        <td style={{ color: "#1e293b" }}>…</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Import guide */}
              {showGuide && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: "#334155", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Step-by-step import</div>
                  {IMPORT_STEPS.map(s => (
                    <div key={s.n} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 7 }}>
                      <span style={{
                        fontSize: 10, fontWeight: 800, fontFamily: "monospace",
                        color: "#3b82f6", background: "rgba(59,130,246,0.1)",
                        border: "1px solid rgba(59,130,246,0.2)",
                        borderRadius: 4, padding: "2px 5px", flexShrink: 0, marginTop: 1,
                      }}>{s.n}</span>
                      <span style={{ fontSize: 12, color: "#64748b", lineHeight: 1.45 }}>{s.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {showCopyModal && <CopyModal />}
      {showGateModal && <GateModal />}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 99px; }
        * { box-sizing: border-box; }
        input::placeholder { color: #334155; }
        select option { background: #1e293b; color: #e2e8f0; }
        button:active { transform: scale(0.97); }
      `}</style>
    </div>
  );
}
