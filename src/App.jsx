import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  ClerkProvider,
  SignIn,
  SignUp,
  useUser,
  useClerk,
  UserButton,
} from "@clerk/clerk-react";

// ── Constants ─────────────────────────────────────────────────────────────────
const HL_LIMIT = 30, DESC_LIMIT = 90, PATH_LIMIT = 15;
const NUM_HL = 15, NUM_DESC = 4;

const TSV_HEADERS = [
  "Campaign", "Ad Group",
  ...Array.from({ length: NUM_HL }, (_, i) => [`Headline ${i + 1}`, `Headline ${i + 1} Position`]).flat(),
  ...Array.from({ length: NUM_DESC }, (_, i) => [`Description ${i + 1}`, `Description ${i + 1} Position`]).flat(),
  "Path 1", "Path 2", "Final URL",
];

const PMAX_TSV_HEADERS = [
  "Campaign", "Asset Group",
  "Business Name",
  ...Array.from({ length: 15 }, (_, i) => `Headline ${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `Long Headline ${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `Description ${i + 1}`),
  "Call to Action",
];

const IMPORT_STEPS = {
  rsa: [
    { n: "01", text: "Open Google Ads Editor, download account (Ctrl+Shift+T)" },
    { n: "02", text: "Left panel → Ads → Responsive search ads" },
    { n: "03", text: 'Click "Make multiple changes"' },
    { n: "04", text: 'Set Destination → "My data includes columns for campaigns / ad groups"' },
    { n: "05", text: 'Click "Paste from clipboard" — done!' },
  ],
  pmax: [
    { n: "01", text: "Open Google Ads, navigate to your PMax campaign" },
    { n: "02", text: "Click into the Asset Group you want to update" },
    { n: "03", text: "Paste headlines, long headlines and descriptions manually into each field" },
    { n: "04", text: "Set Business Name and select Call to Action from the dropdown" },
    { n: "05", text: "Save — Google will auto-assemble the best combinations" },
  ],
};

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

function buildTSV(rows, omitGroup = false, format = "rsa") {
  if (format === "pmax") {
    const headers = omitGroup
      ? PMAX_TSV_HEADERS.filter(h => h !== "Campaign" && h !== "Asset Group")
      : PMAX_TSV_HEADERS;
    const pmaxRows = rows.filter(r => r.pmaxResult);
    if (pmaxRows.length === 0) return headers.join("\t");
    return [
      headers.join("\t"),
      ...pmaxRows.map(r => {
        const p = r.pmaxResult;
        const cells = omitGroup ? [] : [r.campaign || "", r.adGroup || ""];
        return [
          ...cells,
          p.businessName || "",
          ...(p.headlines || Array(15).fill("")),
          ...(p.longHeadlines ? [...p.longHeadlines.slice(0, 5), ...Array(Math.max(0, 5 - p.longHeadlines.length)).fill("")] : Array(5).fill("")),
          ...(p.descriptions || Array(5).fill("")),
          p.callToAction || "",
        ].join("\t");
      }),
    ].join("\n");
  }
  const headers = omitGroup
    ? TSV_HEADERS.filter(h => h !== "Campaign" && h !== "Ad Group")
    : TSV_HEADERS;
  return [
    headers.join("\t"),
    ...rows.map(r => {
      const cells = omitGroup ? [] : [r.campaign, r.adGroup];
      return [
        ...cells,
        ...r.headlines.flatMap(h => [h.text, h.pin || '']),
        ...r.descriptions.flatMap(d => [d.text, d.pin || '']),
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
  if (!text) return "";
  // Remove trailing incomplete fragments — anything after last sentence-ending punctuation
  const clean = text.trimEnd();
  if (clean.length <= DESC_LIMIT + DESC_GRACE) {
    // Within limit — but check for clean ending
    const lastPunct = Math.max(clean.lastIndexOf("."), clean.lastIndexOf("!"), clean.lastIndexOf("?"));
    // If text doesn't end with punct and last sentence is far back, keep as-is
    return clean;
  }
  // Over limit — first try to cut at sentence boundary within limit
  const cut = clean.slice(0, DESC_LIMIT);
  const lastPunct = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
  if (lastPunct > DESC_LIMIT * 0.6) return cut.slice(0, lastPunct + 1); // cut at sentence end
  // Fall back to last word boundary
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}

// ── Description quality scorer ────────────────────────────────────────────────
function scoreDescription(text) {
  try {
    if (!text || typeof text !== "string" || text.trim().length === 0) return { score: "good", flags: [] };
    const flags = [];
    const t = text.trim();
    // Flag descriptions that end abruptly — no sentence-ending punctuation AND no natural noun/verb ending
    const lastChar = t[t.length - 1];
    const hasPunct = ".!?…".includes(lastChar);
    if (!hasPunct) {
      // Ends on a function/connective word = cut off mid-sentence
      if (/\b(and|or|but|with|for|the|a|an|to|of|in|on|at|by|as|is|are|was|were|be|been|your|our|their|this|that|these|those|more|most|from|into|about|when|where|which|who|how|we|you|it|its|all|any|each|every|no|not|can|will|would|could|should|get|do|use|find|see|try|now|here|there|than|then|so|if|up|out|just|also|new|free|best|great|good|even)$/i.test(t)) {
        flags.push("Incomplete sentence");
      }
    }
    // Too short to be useful
    if (t.length < 35) flags.push("Too short");
    // Repeated meaningful word (3+ times)
    const words = t.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/);
    const freq = {};
    words.forEach(w => { if (w.length > 3) freq[w] = (freq[w] || 0) + 1; });
    if (Object.values(freq).some(c => c >= 3)) flags.push("Repeated words");
    // ALL CAPS word (spammy)
    if (/(?<![A-Z])[A-Z]{4,}(?![A-Z])/.test(t)) flags.push("All-caps word");
    // Ends with an ellipsis or dash — likely truncated by the AI
    if (/[–—\-…]$/.test(t)) flags.push("Truncated");
    const score = flags.length === 0 ? "good" : flags.length === 1 ? "warn" : "error";
    return { score, flags };
  } catch (e) {
    return { score: "good", flags: [] };
  }
}
// ── Paginator ─────────────────────────────────────────────────────────────────
function Paginator({ page, total, perPage, onChange }) {
  const totalPages = Math.ceil(total / perPage);
  if (totalPages <= 1) return null;
  // ── Feedback score widget helper ──────────────────────────────────────────
  const ScoreWidget = ({ outputId, format, label = "Rate this output" }) => {
    if (!isSignedIn) return null;
    const fb = feedback[outputId] || {};
    const submit = async (score, comment = '') => {
      setFeedback(prev => ({ ...prev, [outputId]: { score, comment, submitted: true } }));
      setFeedbackOpen(null);
      try {
        await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'submit', userId: user.id, outputId, format, url, score, comment }),
        });
      } catch(_) {}
    };
    return (
      <div style={{ padding: '10px 16px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, color: '#4a5568', fontWeight: 700 }}>{label}</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {[1,2,3,4,5].map(s => (
            <button key={s} onClick={() => {
              submit(s);
              if (s <= 3) setFeedbackOpen(outputId);
            }} style={{
              fontSize: 16, background: 'none', border: 'none', cursor: 'pointer',
              color: (fb.score || 0) >= s ? '#f59e0b' : '#2d3748',
              transition: 'color 0.15s', padding: '0 1px',
            }}>★</button>
          ))}
        </div>
        {fb.submitted && !feedbackOpen && (
          <span style={{ fontSize: 10, color: '#34d399' }}>✓ Thanks!</span>
        )}
        {feedbackOpen === outputId && (
          <div style={{ display: 'flex', gap: 6, flex: 1, minWidth: 200 }}>
            <input
              autoFocus
              placeholder="What could be better? (optional)"
              defaultValue={fb.comment}
              onKeyDown={e => { if (e.key === 'Enter') { submit(fb.score, e.target.value); } }}
              style={{ flex: 1, padding: '4px 8px', fontSize: 11, borderRadius: 6, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#e2e8f0', outline: 'none' }}
            />
            <button onClick={e => submit(fb.score, e.target.previousSibling.value)} style={{ padding: '4px 10px', fontSize: 10, fontWeight: 700, borderRadius: 6, background: 'rgba(245,158,11,0.2)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.3)', cursor: 'pointer' }}>Send</button>
            <button onClick={() => setFeedbackOpen(null)} style={{ padding: '4px 8px', fontSize: 10, borderRadius: 6, background: 'none', color: '#4a5568', border: '1px solid rgba(255,255,255,0.07)', cursor: 'pointer' }}>Skip</button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "6px 0 2px" }}>
      <button onClick={() => onChange(page - 1)} disabled={page === 0} style={{
        background: "none", border: "none", cursor: page === 0 ? "default" : "pointer",
        color: page === 0 ? "#2d3748" : "#7e92a8", fontSize: 13, fontWeight: 700, padding: "2px 6px",
      }}>‹</button>
      <span style={{ fontSize: 10, color: "#4a5568", fontWeight: 700, letterSpacing: "0.06em" }}>
        {page + 1} / {totalPages}
      </span>
      <button onClick={() => onChange(page + 1)} disabled={page >= totalPages - 1} style={{
        background: "none", border: "none", cursor: page >= totalPages - 1 ? "default" : "pointer",
        color: page >= totalPages - 1 ? "#2d3748" : "#7e92a8", fontSize: 13, fontWeight: 700, padding: "2px 6px",
      }}>›</button>
    </div>
  );
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

  // ── Feedback score widget helper ──────────────────────────────────────────
  const ScoreWidget = ({ outputId, format, label = "Rate this output" }) => {
    if (!isSignedIn) return null;
    const fb = feedback[outputId] || {};
    const submit = async (score, comment = '') => {
      setFeedback(prev => ({ ...prev, [outputId]: { score, comment, submitted: true } }));
      setFeedbackOpen(null);
      try {
        await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'submit', userId: user.id, outputId, format, url, score, comment }),
        });
      } catch(_) {}
    };
    return (
      <div style={{ padding: '10px 16px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, color: '#4a5568', fontWeight: 700 }}>{label}</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {[1,2,3,4,5].map(s => (
            <button key={s} onClick={() => {
              submit(s);
              if (s <= 3) setFeedbackOpen(outputId);
            }} style={{
              fontSize: 16, background: 'none', border: 'none', cursor: 'pointer',
              color: (fb.score || 0) >= s ? '#f59e0b' : '#2d3748',
              transition: 'color 0.15s', padding: '0 1px',
            }}>★</button>
          ))}
        </div>
        {fb.submitted && !feedbackOpen && (
          <span style={{ fontSize: 10, color: '#34d399' }}>✓ Thanks!</span>
        )}
        {feedbackOpen === outputId && (
          <div style={{ display: 'flex', gap: 6, flex: 1, minWidth: 200 }}>
            <input
              autoFocus
              placeholder="What could be better? (optional)"
              defaultValue={fb.comment}
              onKeyDown={e => { if (e.key === 'Enter') { submit(fb.score, e.target.value); } }}
              style={{ flex: 1, padding: '4px 8px', fontSize: 11, borderRadius: 6, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#e2e8f0', outline: 'none' }}
            />
            <button onClick={e => submit(fb.score, e.target.previousSibling.value)} style={{ padding: '4px 10px', fontSize: 10, fontWeight: 700, borderRadius: 6, background: 'rgba(245,158,11,0.2)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.3)', cursor: 'pointer' }}>Send</button>
            <button onClick={() => setFeedbackOpen(null)} style={{ padding: '4px 8px', fontSize: 10, borderRadius: 6, background: 'none', color: '#4a5568', border: '1px solid rgba(255,255,255,0.07)', cursor: 'pointer' }}>Skip</button>
          </div>
        )}
      </div>
    );
  };

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
        <div style={{ fontSize: 11, color: "#8fa3b8", marginTop: 2, lineHeight: 1.4 }}>
          {validH}/{NUM_HL} headlines<br />{validD}/{NUM_DESC} descriptions
        </div>
      </div>
    </div>
  );
}

function SerpPreview({ row, favicon }) {
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

  // ── Feedback score widget helper ──────────────────────────────────────────
  const ScoreWidget = ({ outputId, format, label = "Rate this output" }) => {
    if (!isSignedIn) return null;
    const fb = feedback[outputId] || {};
    const submit = async (score, comment = '') => {
      setFeedback(prev => ({ ...prev, [outputId]: { score, comment, submitted: true } }));
      setFeedbackOpen(null);
      try {
        await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'submit', userId: user.id, outputId, format, url, score, comment }),
        });
      } catch(_) {}
    };
    return (
      <div style={{ padding: '10px 16px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, color: '#4a5568', fontWeight: 700 }}>{label}</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {[1,2,3,4,5].map(s => (
            <button key={s} onClick={() => {
              submit(s);
              if (s <= 3) setFeedbackOpen(outputId);
            }} style={{
              fontSize: 16, background: 'none', border: 'none', cursor: 'pointer',
              color: (fb.score || 0) >= s ? '#f59e0b' : '#2d3748',
              transition: 'color 0.15s', padding: '0 1px',
            }}>★</button>
          ))}
        </div>
        {fb.submitted && !feedbackOpen && (
          <span style={{ fontSize: 10, color: '#34d399' }}>✓ Thanks!</span>
        )}
        {feedbackOpen === outputId && (
          <div style={{ display: 'flex', gap: 6, flex: 1, minWidth: 200 }}>
            <input
              autoFocus
              placeholder="What could be better? (optional)"
              defaultValue={fb.comment}
              onKeyDown={e => { if (e.key === 'Enter') { submit(fb.score, e.target.value); } }}
              style={{ flex: 1, padding: '4px 8px', fontSize: 11, borderRadius: 6, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#e2e8f0', outline: 'none' }}
            />
            <button onClick={e => submit(fb.score, e.target.previousSibling.value)} style={{ padding: '4px 10px', fontSize: 10, fontWeight: 700, borderRadius: 6, background: 'rgba(245,158,11,0.2)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.3)', cursor: 'pointer' }}>Send</button>
            <button onClick={() => setFeedbackOpen(null)} style={{ padding: '4px 8px', fontSize: 10, borderRadius: 6, background: 'none', color: '#4a5568', border: '1px solid rgba(255,255,255,0.07)', cursor: 'pointer' }}>Skip</button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{
      background: "#fff",
      borderRadius: 10,
      padding: "16px 18px",
      fontFamily: "Arial, sans-serif",
      boxShadow: "0 2px 16px rgba(0,0,0,0.18)",
    }}>
      {/* Favicon + Ad badge + URL */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <div style={{
          width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
          background: "#f1f3f4", overflow: "hidden",
          display: "flex", alignItems: "center", justifyContent: "center",
          border: "1px solid #e8eaed",
        }}>
          {favicon
            ? <img src={favicon} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} onError={e => { e.target.style.display = "none"; }} />
            : <span style={{ fontSize: 11, color: "#5f6368", fontWeight: 700 }}>{domain[0]?.toUpperCase()}</span>
          }
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#202124", fontWeight: 500, lineHeight: 1.2 }}>{domain || "yoursite.com"}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{
              fontSize: 10, fontWeight: 700, color: "#006621",
              border: "1px solid #006621", borderRadius: 3, padding: "0px 3px"
            }}>Ad</span>
            <span style={{ fontSize: 11, color: "#5f6368" }}>
              {displayUrl || "yoursite.com"}
            </span>
          </div>
        </div>
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

  // ── Feedback score widget helper ──────────────────────────────────────────
  const ScoreWidget = ({ outputId, format, label = "Rate this output" }) => {
    if (!isSignedIn) return null;
    const fb = feedback[outputId] || {};
    const submit = async (score, comment = '') => {
      setFeedback(prev => ({ ...prev, [outputId]: { score, comment, submitted: true } }));
      setFeedbackOpen(null);
      try {
        await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'submit', userId: user.id, outputId, format, url, score, comment }),
        });
      } catch(_) {}
    };
    return (
      <div style={{ padding: '10px 16px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, color: '#4a5568', fontWeight: 700 }}>{label}</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {[1,2,3,4,5].map(s => (
            <button key={s} onClick={() => {
              submit(s);
              if (s <= 3) setFeedbackOpen(outputId);
            }} style={{
              fontSize: 16, background: 'none', border: 'none', cursor: 'pointer',
              color: (fb.score || 0) >= s ? '#f59e0b' : '#2d3748',
              transition: 'color 0.15s', padding: '0 1px',
            }}>★</button>
          ))}
        </div>
        {fb.submitted && !feedbackOpen && (
          <span style={{ fontSize: 10, color: '#34d399' }}>✓ Thanks!</span>
        )}
        {feedbackOpen === outputId && (
          <div style={{ display: 'flex', gap: 6, flex: 1, minWidth: 200 }}>
            <input
              autoFocus
              placeholder="What could be better? (optional)"
              defaultValue={fb.comment}
              onKeyDown={e => { if (e.key === 'Enter') { submit(fb.score, e.target.value); } }}
              style={{ flex: 1, padding: '4px 8px', fontSize: 11, borderRadius: 6, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#e2e8f0', outline: 'none' }}
            />
            <button onClick={e => submit(fb.score, e.target.previousSibling.value)} style={{ padding: '4px 10px', fontSize: 10, fontWeight: 700, borderRadius: 6, background: 'rgba(245,158,11,0.2)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.3)', cursor: 'pointer' }}>Send</button>
            <button onClick={() => setFeedbackOpen(null)} style={{ padding: '4px 8px', fontSize: 10, borderRadius: 6, background: 'none', color: '#4a5568', border: '1px solid rgba(255,255,255,0.07)', cursor: 'pointer' }}>Skip</button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ marginBottom: 6 }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: "#7e92a8", textTransform: "uppercase", letterSpacing: "0.07em" }}>{label}</span>
          {value.trim() && (
            <button
              onClick={() => { setShowRefine(v => !v); setRefineError(""); }}
              title="Refine this field with AI"
              style={{
                background: "none", border: "none", cursor: "pointer", padding: "1px 3px",
                fontSize: 11, opacity: hovered || showRefine ? 1 : 0,
                color: showRefine ? "#6366f1" : "#7e92a8",
                transition: "opacity 0.15s, color 0.15s", lineHeight: 1,
              }}>✏</button>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {onPinChange && (
            <select value={pinValue} onChange={e => onPinChange(e.target.value)}
              style={{ fontSize: 10, padding: "2px 4px", border: "1px solid #8fa3b8", borderRadius: 4, background: "#1e293b", color: "#adbccb", cursor: "pointer" }}>
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
          {refineError ? <div style={{ fontSize: 10, color: "#f87171", marginTop: 5 }}>{refineError}</div>
          : null}
        </div>
      )}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
// ── Clerk-wrapped entry point ─────────────────────────────────────────────────
const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

export default function App() {
  return (
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/">
      <RSAStudio />
    </ClerkProvider>
  );
}

function RSAStudio() {
  const [url, setUrl] = useState("");
  const [adFormat, setAdFormat] = useState("rsa"); // "rsa" | "pmax" | "meta"
  const [generateMeta, setGenerateMeta] = useState(false); // opt-in checkbox
  const [imageModel, setImageModel] = useState('imagen'); // 'dalle' | 'imagen'
  const [metaResult, setMetaResult] = useState(null);
  const [activeImageVariant, setActiveImageVariant] = useState(0);
  const [metaEdits, setMetaEdits] = useState({}); // { 'pt-0': 'text', 'hl-0': 'text', 'desc-0': 'text' }
  const [metaEditingField, setMetaEditingField] = useState(null); // which field is open
  const [videoTask, setVideoTask] = useState(null);   // { taskId, status, videoUrl, polling }       // { primaryTexts, headlines, descriptions, imageUrl }
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState("");
  const [metaCopied, setMetaCopied] = useState(false);
  const [metaPreviewFormat, setMetaPreviewFormat] = useState("fb-feed"); // fb-feed|ig-feed|ig-story|fb-story
  // ── TikTok state ─────────────────────────────────────────────────────────────
  const [tiktokResult, setTiktokResult] = useState(null);
  const [tiktokLoading, setTiktokLoading] = useState(false);
  const [tiktokError, setTiktokError] = useState('');
  const [tiktokVideoLoading, setTiktokVideoLoading] = useState(false);
  const [tiktokVideoUrl, setTiktokVideoUrl] = useState(null);
  const [ugcVideoUrl, setUgcVideoUrl] = useState(null);
  const [ugcLoading, setUgcLoading] = useState(false);
  const [ugcAvatar, setUgcAvatar] = useState('Ivy'); // selected HeyGen voice/avatar
  const [ugcScene, setUgcScene] = useState('talking'); // talking | product | friends
  const [videoEngine, setVideoEngine] = useState('kling'); // 'kling' | 'runway'
  // Keep ref in sync so async handlers always get current value
  useEffect(() => { videoEngineRef.current = videoEngine; }, [videoEngine]);
  const [overlayLogo, setOverlayLogo] = useState(true); // inject brand name
  const [overlayIntro, setOverlayIntro] = useState(''); // custom intro headline
  const [overlayOutro, setOverlayOutro] = useState(''); // custom outro/exit messageatar
  const [generateTiktok, setGenerateTiktok] = useState(false);
  const [editOpen, setEditOpen] = useState(false); // RSA edit accordion
  const [tiktokExportCopied, setTiktokExportCopied] = useState(false);
  const [enhanceOpen, setEnhanceOpen] = useState(false);
  const [enhanceIntro, setEnhanceIntro] = useState('');
  const [enhanceOutro, setEnhanceOutro] = useState('');
  const [enhanceBrand, setEnhanceBrand] = useState(true);
  const [metaActiveVariants, setMetaActiveVariants] = useState({ pt: 0, hl: 0, d: 0 }); // active variant indices
  const [pmaxLogo, setPmaxLogo] = useState(null); // auto-fetched favicon/logo URL
  // Imagen modal state
  const [imagenOpen, setImagenOpen] = useState(false);
  const [imagenStep, setImagenStep] = useState(1);
  const [imagenTab, setImagenTab] = useState('upload'); // 'upload' | 'url'
  const [imagenUrlInput, setImagenUrlInput] = useState('');
  const [imagenParsedImages, setImagenParsedImages] = useState([]);
  const [remixOpen, setRemixOpen] = useState(false);
  const [metaImagesLoading, setMetaImagesLoading] = useState(false);
  const metaGenId = useRef(0); // increments each generation to cancel stale callbacks
  const tiktokSourceImageRef = useRef(null); // persists user-selected image through Meta regen
  const videoEngineRef = useRef('kling'); // always reflects current videoEngine (avoids stale closure)

  const detectVideoEngine = (imgUrl) => {
    if (!imgUrl) return 'kling';
    const url = imgUrl.toLowerCase();
    const modelSignals = /model|lifestyle|worn|lookbook|campaign|editorial|fashion|outfit|wear|style|portrait|cashmere|silk|linen|kleid|kjole|blazer|jacket|jakke/i;
    const fashionDomains = /nordicweaving|boozt|stylepit|ellos|miinto|kaufmann|magasin|illum|zalando|asos|hm\.|zara/i;
    const dimMatch = url.match(/(\d+)x(\d+)/);
    if (dimMatch) {
      const w = parseInt(dimMatch[1]), h = parseInt(dimMatch[2]);
      if (h > w * 1.3) return 'runway';
    }
    if (modelSignals.test(url) || fashionDomains.test(url)) return 'runway';
    return 'kling';
  };
  const [remixSourceUrl, setRemixSourceUrl] = useState(null); // the lifestyle image to remix into
  const [remixProduct, setRemixProduct] = useState(null);     // selected product image
  const [remixGenerating, setRemixGenerating] = useState(false);
  const [remixError, setRemixError] = useState('');
  const [imagenParsing, setImagenParsing] = useState(false);
  const [imagenSelected, setImagenSelected] = useState(null); // { src, base64, mimeType }
  const [imagenStylePrompt, setImagenStylePrompt] = useState('');
  const [imagenGenerating, setImagenGenerating] = useState(false);
  const [imagenPreview, setImagenPreview] = useState(null);
  const [imagenError, setImagenError] = useState('');
  // ── Batch mode state ──────────────────────────────────────────────────────
  const [showBatchPanel, setShowBatchPanel] = useState(false);
  const [batchTab, setBatchTab] = useState("scan"); // "scan" | "paste"
  const [batchPasteText, setBatchPasteText] = useState("");
  const [batchUrls, setBatchUrls] = useState([]); // [{ url, category, selected }]
  // Scanner state
  const [scanDomain, setScanDomain] = useState("");
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState("");
  const [scanCategories, setScanCategories] = useState([]); // [{ slug, name, urls, count }]
  const [scanMethod, setScanMethod] = useState("");
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [scanLocales, setScanLocales] = useState([]);        // locale picker results
  const [scanScannedDomain, setScanScannedDomain] = useState(""); // origin after scan
  const [cachedLocales, setCachedLocales] = useState([]);    // hreflang cache — survives category drill-down
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [showAdSwitcher, setShowAdSwitcher] = useState(false);
  const [switcherPage, setSwitcherPage] = useState(0);   // ad switcher page
  const [historyPage, setHistoryPage] = useState(0);     // history panel page
  const ADS_PER_PAGE = 5;
  // ── PMax Image Assets ─────────────────────────────────────────────────────
  const [showImagePanel, setShowImagePanel] = useState(false);
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [imageGuidance, setImageGuidance] = useState("");
  const [imageLoading, setImageLoading] = useState(false);
  const [generatedImages, setGeneratedImages] = useState([]);
  const [imageAnalysis, setImageAnalysis] = useState(null);
  const [creativeStyle, setCreativeStyle] = useState("match"); // match/studio/lifestyle/other
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [rows, setRows] = useState([makeRow(1)]);
  const [activeRow, setActiveRow] = useState(0);
  const [generated, setGenerated] = useState(false);
  const [clearKey, setClearKey] = useState(0);
  // Admin mode — detected from ?admin=KEY URL param, persisted in sessionStorage
  const { isSignedIn, user } = useUser();
  const { signOut, session } = useClerk();
  const plan = user?.publicMetadata?.plan || 'free';
  const isPro = plan === 'pro';
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [upgradeFeature, setUpgradeFeature] = useState('');
  const [upgradePlan, setUpgradePlan] = useState('monthly');
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState("sign-in"); // "sign-in" | "sign-up"
  const [isAdmin, setIsAdmin] = useState(false);
  // ── Audience Modifiers (free tier — persistent via Redis) ─────────────────
  const [audiences, setAudiences] = useState([]);
  const [audiencesLoaded, setAudiencesLoaded] = useState(false);
  const [showAudiencePanel, setShowAudiencePanel] = useState(false);
  const [stickyAudiences, setStickyAudiences] = useState(true); // sticky = persist across URLs
  // ── Google Trends ─────────────────────────────────────────────────────────
  const [trends, setTrends] = useState([]);
  const [trendsLoading, setTrendsLoading] = useState(false);
  const [selectedTrends, setSelectedTrends] = useState([]);
  const [showTrendsPanel, setShowTrendsPanel] = useState(false);
  // Load library on sign-in
  useEffect(() => {
    if (!isSignedIn || !user?.id || libraryLoaded) return;
    fetch('/api/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'load', userId: user.id, plan }),
    }).then(r => r.json()).then(d => {
      if (d.entries) setLibrary(d.entries);
      setLibraryLoaded(true);
    }).catch(() => setLibraryLoaded(true));
  }, [isSignedIn, user?.id]);

  // Load saved audiences from Redis when user signs in
  useEffect(() => {
    if (!isSignedIn || !user?.id) return;
    fetch("/api/audiences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get", userId: user.id }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.audiences) setAudiences(data.audiences);
        setAudiencesLoaded(true);
      })
      .catch(() => setAudiencesLoaded(true));
  }, [isSignedIn, user?.id]);

  // Save audiences to Redis whenever they change
  useEffect(() => {
    if (!isSignedIn || !user?.id || !audiencesLoaded) return;
    fetch("/api/audiences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", userId: user.id, audiences }),
    }).catch(() => {});
  }, [audiences, isSignedIn, user?.id, audiencesLoaded]);

  useEffect(() => {
    const urlKey = new URLSearchParams(window.location.search).get("admin");
    const storedKey = sessionStorage.getItem("rsa_admin_key");
    const key = urlKey || storedKey || "";
    if (urlKey) sessionStorage.setItem("rsa_admin_key", urlKey);
    const adminKey = import.meta.env.VITE_ADMIN_KEY;
    if (adminKey && key && key === adminKey) setIsAdmin(true);
  }, []);
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
  const [marketingOptIn, setMarketingOptIn] = useState(false); // unchecked by default — GDPR compliant
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
  const [library, setLibrary] = useState([]);
  const [audienceDesc, setAudienceDesc] = useState('');
  const [audienceBrief, setAudienceBrief] = useState(null);
  const [audienceLoading, setAudienceLoading] = useState(false);
  const [showAudienceBrief, setShowAudienceBrief] = useState(false);
  const [audienceBriefEdits, setAudienceBriefEdits] = useState({}); // user overrides
  const [feedback, setFeedback] = useState({});     // { outputId: { score, comment, submitted } }
  const [feedbackOpen, setFeedbackOpen] = useState(null); // outputId with open comment box
  const [showFeedbackDash, setShowFeedbackDash] = useState(false);
  const [feedbackDashData, setFeedbackDashData] = useState([]);
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [librarySaving, setLibrarySaving] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedForExport, setSelectedForExport] = useState(new Set()); // history ids selected
  const [currentAdSelected, setCurrentAdSelected] = useState(true); // current ad included in multi-export
  const [multiCopied, setMultiCopied] = useState(false);
  const [omitGroupMulti, setOmitGroupMulti] = useState(false); // toggle campaign/ad group in multi-export

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

  // ── Batch helpers ─────────────────────────────────────────────────────────
  const parseBatchUrls = (text) => {
    const lines = text.split(/[\n,]/).map(l => l.trim()).filter(l => l.length > 4);
    const seen = new Set();
    return lines.reduce((acc, raw) => {
      let url;
      try { url = raw.startsWith("http") ? raw : "https://" + raw; new URL(url); } catch { return acc; }
      if (seen.has(url)) return acc;
      seen.add(url);
      let category = "Other";
      try {
        const segs = new URL(url).pathname.split("/").filter(Boolean);
        if (segs.length > 0) {
          const seg = segs[0].replace(/[-_]/g, " ").replace(/\.html?$/, "");
          category = seg.charAt(0).toUpperCase() + seg.slice(1);
        }
      } catch {}
      return [...acc, { url, category, selected: true }];
    }, []);
  };

  // ── Domain scanner ────────────────────────────────────────────────────────
  const runScan = async (domainOverride, localeOverride) => {
    const domain = domainOverride || scanDomain.trim();
    if (!domain) return;
    setScanLoading(true);
    setScanError("");
    setScanCategories([]);
    setScanLocales([]);
    setCachedLocales([]);
    setSelectedCategory(null);
    try {
      const body = { domain };
      if (localeOverride) body.locale = localeOverride;
      const res = await fetch("/api/sitemap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) {
        if (data.fallback) {
          // Show explanation then auto-switch to paste tab
          setScanError(data.diagnosis || data.error);
          setTimeout(() => { setBatchTab("paste"); setScanError(""); }, 3000);
        } else {
          setScanError(data.diagnosis || data.error);
        }
      } else if (data.mode === "locale") {
        const locales = data.locales || [];
        setScanLocales(locales);
        setScanScannedDomain(data.domain || domain);
        setScanMethod(data.method || "");
        // Cache hreflang locales — used by Change market to avoid re-scan
        if (data.source === "hreflang") setCachedLocales(locales);
      } else {
        // Straight to categories
        setScanCategories(data.categories || []);
        setScanMethod(data.method || "");
      }
    } catch (e) {
      setScanError("Network error — please try again");
    }
    setScanLoading(false);
  };

  const loadCategory = (cat) => {
    setSelectedCategory(cat);
    const parsed = cat.urls.map(url => {
      let category = cat.name;
      try {
        const segs = new URL(url).pathname.split("/").filter(Boolean);
        if (segs.length > 1) {
          const seg = segs[segs.length - 1].replace(/[-_]/g, " ").replace(/\.html?$/, "");
          category = seg.charAt(0).toUpperCase() + seg.slice(1);
        }
      } catch {}
      return { url, category, selected: true };
    });
    setBatchUrls(parsed);
  };

  const runBatchGeneration = async () => {
    const selected = batchUrls.filter(b => b.selected);
    if (!selected.length) return;
    setBatchRunning(true);
    setBatchProgress({ current: 0, total: selected.length });
    setUrl(""); // Clear single URL so colour coding reacts to batchRunning
    const newRows = [];
    for (let i = 0; i < selected.length; i++) {
      setBatchProgress({ current: i + 1, total: selected.length });
      try {
        let metaCtx = "";
        let meta = { language: "English", title: "", metaDescription: "", h1: "", siteName: "" };
        try {
          const scrapeRes = await fetch("/api/scrape", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: selected[i].url }),
          });
          if (scrapeRes.ok) {
            const sd = await scrapeRes.json();
            meta = { ...meta, ...sd };
            metaCtx = [sd.title && "Title: " + sd.title, sd.metaDescription && "Meta: " + sd.metaDescription, sd.h1 && "H1: " + sd.h1, sd.siteName && "Brand: " + sd.siteName].filter(Boolean).join("\n");
          }
        } catch {}

        const prompt = "You are a Google Ads expert. Generate RSA ad copy.\nCURRENT YEAR: " + new Date().getFullYear() + "\nURL: " + selected[i].url + "\nPAGE METADATA:\n" + (metaCtx || "Infer from URL.") + "\nOUTPUT LANGUAGE: " + meta.language + "\nCRITICAL: Write ALL copy in " + meta.language + ".\n\nReturn ONLY valid JSON, no markdown:\n{\n  \"campaign\": \"name\",\n  \"adGroup\": \"name\",\n  \"headlines\": [\"h1\",...15 total],\n  \"descriptions\": [\"d1\",\"d2\",\"d3\",\"d4\"],\n  \"path1\": \"p1\",\n  \"path2\": \"p2\"\n}\nRules: Headlines max 30 chars each, exactly 15, unique. Descriptions 80-90 chars each, exactly 4, complete sentences ending with punctuation. path1/path2 max 15 chars.";

        const res = await fetch("/api/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(isAdmin ? { "x-admin-key": import.meta.env.VITE_ADMIN_KEY } : {}),
            ...(isSignedIn && session ? { "x-clerk-session": await session.getToken() } : {}),
          },
          body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
        });

        if (!res.ok || res.status === 429) continue;
        const data = await res.json();
        if (data.gated) { setBatchRunning(false); setShowGateModal(true); return; }
        if (data.usage_count) setUsageCount(data.usage_count);

        console.log("Batch response for", selected[i].url, ":", JSON.stringify(data).slice(0, 200));
        const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
        if (!text) { console.error("No text in response:", data); continue; }
        const clean = text.replace(/```json[\s\S]*?```|```/g, "").trim();
        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        if (!jsonMatch) { console.error("No JSON found in:", clean.slice(0, 200)); continue; }
        const p = JSON.parse(jsonMatch[0]);

        const newRow = makeRow(Date.now() + i);
        newRow.finalUrl = selected[i].url;
        newRow.campaign = p.campaign || "";
        newRow.adGroup = p.adGroup || "";
        newRow.headlines = Array.from({ length: NUM_HL }, (_, j) => ({ text: (p.headlines?.[j] || "").slice(0, HL_LIMIT), pin: "" }));
        newRow.descriptions = Array.from({ length: NUM_DESC }, (_, j) => ({ text: smartTrimDesc(p.descriptions?.[j] || ""), pin: "" }));
        newRow.path1 = (p.path1 || "").slice(0, PATH_LIMIT);
        newRow.path2 = (p.path2 || "").slice(0, PATH_LIMIT);
        newRows.push({ row: newRow, url: selected[i].url });

        // Update rows live so each ad appears as it completes
        setRows(prev => {
          const hasContent = prev.some(r => r.headlines.some(h => h.text) || r.finalUrl);
          return hasContent ? [...prev, newRow] : [newRow];
        });

        setHistory(prev => {
          const snap = { id: Date.now() + i, url: selected[i].url, format: "rsa", timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), rows: [newRow] };
          return [snap, ...prev].slice(0, 20);
        });
        setSessionUrls(prev => [...new Set([...prev, selected[i].url])]);
      } catch (e) {
        console.error("Batch item error for", selected[i].url, ":", e);
        setError("Batch error on " + selected[i].url + ": " + e.message);
      }
      if (i < selected.length - 1) await new Promise(r => setTimeout(r, 600));
    }

    if (newRows.length > 0) {
      // Point to the last generated ad — rows already updated live during generation
      setRows(prev => {
        const lastIdx = prev.length - 1;
        setActiveRow(lastIdx);
        return prev;
      });
      setUrl(newRows[newRows.length - 1].url);
      setGenerated(true);
      setSwitcherPage(0);
    }
    setBatchRunning(false);
    setShowBatchPanel(false);
    setBatchPasteText("");
    setBatchUrls([]);
    setScanCategories([]);
    setScanLocales([]);
    setSelectedCategory(null);
    setScanDomain("");
    setScanScannedDomain("");
    setScanError("");
  };

  const generate = async () => {
    if (!url.trim()) { setError("Please enter a URL first"); return; }

    // ── Auto-build audience brief if text entered but not yet built ───────────
    if (audienceDesc.trim() && !audienceBrief) {
      setAudienceLoading(true);
      try {
        const scrapeRes = await fetch('/api/scrape', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
        const scrapeData = await scrapeRes.json();
        const r = await fetch('/api/audience', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, pageContent: scrapeData.content || '', audienceDescription: audienceDesc, language: 'English' }),
        });
        const brief = await r.json();
        setAudienceBrief(brief);
        setAudienceBriefEdits({});
      } catch(e) { console.warn('Auto audience build failed:', e); }
      setAudienceLoading(false);
    }

    setLoading(true); setError("");
    // Clear previous meta result and cancel any in-flight image callbacks
    setMetaResult(null);
    setMetaImagesLoading(false);
    metaGenId.current += 1;
    // Clear trends on new generation, clear audiences if not sticky
    setTrends([]);
    setSelectedTrends([]);
    if (!stickyAudiences) setAudiences([]);
    try {
      // ── Step 0: Client-side URL language extraction (runs before scrape, immune to redirects) ──
      const urlLangCodes = {
        de: "German", fr: "French", it: "Italian", es: "Spanish", nl: "Dutch",
        pt: "Portuguese", pl: "Polish", sv: "Swedish", da: "Danish", fi: "Finnish",
        no: "Norwegian", nb: "Norwegian", cs: "Czech", sk: "Slovak", hu: "Hungarian",
        ro: "Romanian", hr: "Croatian", bg: "Bulgarian", el: "Greek", sr: "Serbian",
        uk: "Ukrainian", ru: "Russian", tr: "Turkish", zh: "Chinese", ja: "Japanese",
        ko: "Korean", ar: "Arabic", is: "Icelandic", lt: "Lithuanian", lv: "Latvian",
        et: "Estonian", sl: "Slovenian",
      };
      const iso3LangCodes = {
        svk: "Slovak", cze: "Czech", pol: "Polish", deu: "German", fra: "French",
        ita: "Italian", esp: "Spanish", nld: "Dutch", por: "Portuguese", swe: "Swedish",
        dan: "Danish", nor: "Norwegian", fin: "Finnish", hun: "Hungarian", ron: "Romanian",
        hrv: "Croatian", srp: "Serbian", bul: "Bulgarian", ell: "Greek", ukr: "Ukrainian",
        rus: "Russian", tur: "Turkish", zho: "Chinese", jpn: "Japanese", kor: "Korean",
        ara: "Arabic", isl: "Icelandic", lit: "Lithuanian", lav: "Latvian", est: "Estonian",
        slk: "Slovak", slv: "Slovenian",
      };
      const tldLangCodes = {
        dk: "Danish", se: "Swedish", no: "Norwegian", fi: "Finnish", is: "Icelandic",
        de: "German", at: "German", fr: "French", it: "Italian", es: "Spanish",
        nl: "Dutch", pt: "Portuguese", pl: "Polish", cz: "Czech", sk: "Slovak",
        hu: "Hungarian", ro: "Romanian", hr: "Croatian", bg: "Bulgarian", gr: "Greek",
        ru: "Russian", tr: "Turkish", cn: "Chinese", tw: "Chinese", jp: "Japanese",
        kr: "Korean", br: "Portuguese", ua: "Ukrainian",
      };
      const _pathMatch = url.match(/\/([a-z]{2})(?:-[a-z]{2})?\//);
      const _pathMatch3 = url.match(/[/_]([a-z]{3})(?:[/_]|$)/i);
      const urlPathLang = (_pathMatch ? urlLangCodes[_pathMatch[1]?.toLowerCase()] || null : null)
        || (_pathMatch3 ? iso3LangCodes[_pathMatch3[1]?.toLowerCase()] || null : null) || null;
      const urlTld = url.match(/\.([a-z]{2})(?:\/|$)/i)?.[1]?.toLowerCase();
      const tldFallbackLang = urlTld ? tldLangCodes[urlTld] || null : null;
      const clientLang = urlPathLang || tldFallbackLang || null;

      // ── Step 1: Scrape page metadata (language, meta description, title, OG tags) ──
      // clientLang from URL is used as guaranteed fallback if scrape fails or returns English
      let pageMeta = { language: clientLang || "English", title: null, metaDescription: null, siteName: null, h1: null };
      try {
        // Auto-fetch favicon for PMax logo
        if (url.trim()) {
          try {
            const domain = new URL(url).hostname;
            const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
            setPmaxLogo(faviconUrl);
          } catch (_) {}
        }
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

      // ── Step 1b: Fetch Google Trends in parallel (fire and forget) ─────────────
      if (isSignedIn && pageMeta.title && trends.length === 0) {
        const urlPathParts = url.split("/").filter(p =>
          p.length > 3 &&
          !p.match(/^(www|http|https|com|de|en|uk|fr|es|it|nl|gb|us|at|ch)$/i) &&
          !p.match(/^[a-z]{2}_[a-z]{2}$/i)
        );
        const pathKeyword = urlPathParts[urlPathParts.length - 1]?.replace(/[-_]/g, " ") || "";
        const metaKeyword = pageMeta.h1?.split(/[|\-–]/)[0]?.trim() || pageMeta.title?.split(/[|\-–]/)[0]?.trim() || "";
        const trendSeed = metaKeyword || pathKeyword || pageMeta.siteName || "";
        const trendGeo = pageMeta.language === "German" ? "DE"
          : pageMeta.language === "French" ? "FR"
          : pageMeta.language === "Spanish" ? "ES"
          : pageMeta.language === "Dutch" ? "NL"
          : pageMeta.language === "Italian" ? "IT"
          : pageMeta.language === "Portuguese" ? "PT"
          : pageMeta.language === "Swedish" ? "SE"
          : pageMeta.language === "Danish" ? "DK"
          : pageMeta.language === "Norwegian" ? "NO"
          : "US";
        // Fire and forget — trends load independently, panel appears when ready
        setTrendsLoading(true);
        fetch("/api/trends", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            keyword: trendSeed,
            geo: trendGeo,
            language: pageMeta.language,
            title: pageMeta.title,
            metaDescription: pageMeta.metaDescription,
            h1: pageMeta.h1,
            siteName: pageMeta.siteName,
          }),
        }).then(r => r.json()).then(trendData => {
          if (trendData.trends?.length > 0) {
            setTrends(trendData.trends);
            setShowTrendsPanel(true);
          }
          setTrendsLoading(false);
        }).catch(() => setTrendsLoading(false));
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

      // ── Step 2d: Build audience modifier instructions ────────────────────────
      const activeAudiences = audiences.filter(a => a.name?.trim());
      const audienceLines = activeAudiences.map((a, i) =>
        "Segment " + (i + 1) + ": " + a.name + "\n" +
        "- Pain points / motivations: " + (a.painPoints || "not specified") + "\n" +
        "- Preferred tone: " + (a.tone || "Professional")
      ).join("\n");
      const audienceInstruction = activeAudiences.length > 0
        ? "\n\nAUDIENCE MODIFIERS (" + activeAudiences.length + " segment" + (activeAudiences.length > 1 ? "s" : "") + " active):\n" +
          audienceLines + "\n" +
          "- Write copy that resonates with these audience segments — reflect their language, concerns and motivations\n" +
          "- Distribute audience-specific angles across the headlines — do not cluster them all together"
        : "";

      // ── Step 2e: Build trends instruction ────────────────────────────────────
      const activeTrends = selectedTrends.length > 0 ? selectedTrends : [];
      const trendLines = activeTrends.map(t => '- "' + t + '"').join("\n");
      const trendsInstruction = activeTrends.length > 0
        ? "\n\nTRENDING TOPICS TO LEVERAGE:\n" +
          "The following topics are currently trending in searches related to this product/brand:\n" +
          trendLines + "\n" +
          "- Weave 1-2 of these trending angles naturally into headlines or descriptions where relevant\n" +
          "- Only use a trend if it genuinely fits the product — do not force irrelevant trends"
        : "";

      // ── Step 3: Generate ad copy (format-aware) ────────────────────────────
      if (adFormat === "pmax") {
        // ── PMax generation ──
        const pmaxRes = await fetch("/api/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(isAdmin ? { "x-admin-key": import.meta.env.VITE_ADMIN_KEY } : {}),
            ...(isSignedIn && session ? { "x-clerk-session": await session.getToken() } : {}),
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 2000,
            messages: [{
              role: "user",
              content: `You are a Google Ads expert. Generate a PMax asset group for this landing page.
OUTPUT LANGUAGE: ${pageMeta.language}
CRITICAL: Write ALL copy in ${pageMeta.language}. Do not use English if the language is not English.

Page URL: ${url}
${pageMeta.title ? `Page Title: ${pageMeta.title}` : ""}
${pageMeta.metaDescription ? `Meta Description: ${pageMeta.metaDescription}` : ""}
${pageMeta.h1 ? `H1: ${pageMeta.h1}` : ""}
${pageMeta.siteName ? `Brand: ${pageMeta.siteName}` : ""}
${audienceInstruction}

Return ONLY valid JSON — no prose, no markdown fences:
{
  "businessName": "max 25 chars",
  "businessName": "max 25 chars",
  "headlines": ["h1","h2","h3","h4","h5","h6","h7","h8","h9","h10","h11","h12","h13","h14","h15"],
  "longHeadlines": ["lh1 max 60 chars","lh2","lh3","lh4","lh5"],
  "callToAction": "one of: Shop Now, Learn More, Sign Up, Get Quote, Apply Now, Book Now, Contact Us, Download, Get Offer, Order Now, Subscribe, Visit Site"
}

Rules:
- businessName: max 25 chars — use brand name only
- headlines: exactly 15, max 30 chars each — short punchy phrases
- longHeadlines: exactly 5, max 90 chars each — complete value propositions, no punctuation at end. IMPORTANT: longHeadlines[0] must be max 60 chars. longHeadlines[1-4] max 90 chars.
- descriptions: exactly 5, max 90 chars each — benefit-focused, include CTA
- callToAction: pick the single most relevant option from the list above`
            }],
          }),
        });
        const pmaxData = await pmaxRes.json();
        if (pmaxData.gated) {
          setUsageCount(pmaxData.count || FREE_LIMIT);
          setShowGateModal(true);
          setLoading(false);
          return;
        }
        try {
          const pmaxText = pmaxData.content?.[0]?.text || "";
          const pmaxClean = pmaxText.replace(/\`\`\`json|\`\`\`/g, "").trim();
          const pmaxParsed = JSON.parse(pmaxClean);
          updateRow(activeRow, r => ({ ...r, pmaxResult: pmaxParsed }));
          setGenerated(true);
          // Track usage count
          if (pmaxData.usage_count) setUsageCount(pmaxData.usage_count);
          // Save to history
          setSessionUrls(prev => [...new Set([...prev, url])]);
          setSessionLangs(prev => [...new Set([...prev, pageMeta.language || "English"])]);
          setHistory(prev => {
            const snapshot = {
              id: Date.now(),
              url,
              format: "pmax",
              timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
              rows: JSON.parse(JSON.stringify(rows.map((r, i) => i === activeRow ? { ...r, pmaxResult: pmaxParsed } : r))),
              metaResult: metaResult || null,
            };
            return [snapshot, ...prev].slice(0, 20);
          });
        } catch (e) {
          setError("Could not parse PMax response — please try again");
        }
        setLoading(false);
        return;
      }

      // ── RSA generation (original) ──
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(isAdmin ? { "x-admin-key": import.meta.env.VITE_ADMIN_KEY } : {}),
          ...(isSignedIn && session ? { "x-clerk-session": await session.getToken() } : {}),
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
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

${kwInstruction}${seasonInstruction}${discountInstruction}${brandInstruction}${modifierWarning}${audienceInstruction}${trendsInstruction}

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
          metaResult: metaResult || null,
        };
        const updated = [snapshot, ...prev].slice(0, 20);
        setHistoryPage(0);
        return updated;
      });
      // ── Meta generation (opt-in) ─────────────────────────────────────────
      if (generateMeta) {
        setMetaLoading(true);
        setMetaError("");
        setMetaImagesLoading(false);
        setMetaResult(null); // clear previous result to avoid stale images
        metaGenId.current += 1; // invalidate any in-flight async image callbacks
        setActiveImageVariant(0);
        setMetaEdits({});
        setAdFormat("meta"); // switch to meta tab immediately so user sees spinner
        try {
          const metaRes = await fetch("/api/generate-meta", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, language: pageMeta?.language || 'English', imageModel, isPro, audienceBrief: audienceBrief ? { copySignals: audienceBrief.copySignals, messagingTone: audienceBrief.messagingTone, painPoints: audienceBrief.painPoints, demographics: audienceBrief.demographics } : null }),
          });
          const metaRaw = await metaRes.text();
          let metaData;
          try { metaData = JSON.parse(metaRaw); }
          catch(_) { throw new Error(`Server error (${metaRes.status}): ${metaRaw.slice(0, 120)}`); }
          if (metaData.error) {
            setMetaError("Meta generation error: " + metaData.error);
          } else if (!metaData.primaryTexts?.length && !metaData.headlines?.length) {
            setMetaError("Meta generation returned empty response — please try again");
          } else {
            setMetaError("");
            // Use scraped product image as primary FB preview if available
            const initialImageUrl = metaData.heroProductImage || metaData.imageUrl || null;
            const initialVariations = [
              metaData.heroProductImage,
              metaData.secondaryImage,
              metaData.tertiaryImage,
              metaData.homepageImage,
            ].filter(Boolean);
            setMetaResult({
              ...metaData,
              imageUrl: initialImageUrl,
              imageVariations: initialVariations.length > 0 ? initialVariations : [],
            });
            setActiveImageVariant(0);
            tiktokSourceImageRef.current = null; // reset so video button uses activeImageVariant
            setVideoEngine(detectVideoEngine(initialImageUrl));
            setVideoTask(null);
            setMetaEdits({});
            setMetaEditingField(null);

            // ── Async image generation if prompts returned ──────────────────
            if (metaData.imagePrompts) {
              setMetaImagesLoading(true);
              const { s1, v1, v2 } = metaData.imagePrompts;
              const genImg = async (prompt) => {
                if (!prompt) return null;
                for (let attempt = 0; attempt < 2; attempt++) {
                  try {
                    const r = await fetch('/api/imagen', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ prompt }),
                    });
                    const d = await r.json();
                    if (d.imageUrl) return d.imageUrl;
                  } catch(_) {}
                  if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
                }
                return null;
              };
              const thisGenId = metaGenId.current;
              Promise.all([
                genImg(s1),
                genImg(v1),
                genImg(v2 || null),
              ]).then(([is1, iv1, iv2]) => {
                if (metaGenId.current !== thisGenId) return; // stale — newer generation started
                setMetaImagesLoading(false);
                const aiVariations = [is1, iv1, iv2].filter(Boolean);
                if (aiVariations.length > 0) {
                  setMetaResult(prev => {
                    if (!prev) return prev;
                    // Keep hero product image as first if present, then AI variations
                    const hero = metaData.heroProductImage;
                    const secondary = metaData.secondaryImage;
                    const tertiary = metaData.tertiaryImage;
                    const homepage = metaData.homepageImage;
                    const variations = [
                      hero,
                      secondary,
                      tertiary,
                      homepage,
                      ...aiVariations,
                    ].filter(Boolean);
                    return {
                      ...prev,
                      imageUrl: prev.imageUrl || variations[0],
                      imageVariations: variations,
                    };
                  });
                }
              });
            }
            // Persist metaResult into the most recent history entry for this URL
            setHistory(prev => {
              if (!prev.length) return prev;
              const updated = [...prev];
              // Find the most recent entry matching this URL
              const idx = updated.findIndex(h => h.url === url);
              if (idx !== -1) updated[idx] = { ...updated[idx], metaResult: metaData };
              return updated;
            });
          }
        } catch (e) {
          console.error("Meta generation failed:", e.message);
          setMetaError("Meta generation failed — " + e.message);
        }
        setMetaLoading(false);
      }

      // ── TikTok generation (opt-in) ────────────────────────────────────────
      if (generateTiktok) {
        setTiktokLoading(true);
        setTiktokError("");
        setTiktokResult(null);
        setTiktokVideoUrl(null);
        if (!generateMeta) {
          setAdFormat("tiktok");
          setTimeout(() => { const rp = document.getElementById("right-panel"); const ts = document.getElementById("tiktok-section"); if (rp && ts) rp.scrollTo({ top: rp.scrollHeight, behavior: "smooth" }); }, 300);
        }
        try {
          const tiktokRes = await fetch("/api/generate-tiktok", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, language: pageMeta?.language || "English", videoEngine, audienceBrief, pageContent: pageMeta?.content || "" }),
          });
          const tiktokData = await tiktokRes.json();
          if (tiktokData.error) {
            setTiktokError("TikTok generation error: " + tiktokData.error);
          } else {
            setTiktokResult(tiktokData);
          }
        } catch (e) {
          setTiktokError("TikTok generation failed — " + e.message);
        }
        setTiktokLoading(false);
      }
      setError("Generation failed — " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const tsvText = buildTSV(rows, false, adFormat);
  const tsvTextNoGroup = buildTSV(rows, true, adFormat);

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
    const tsv = buildTSV(rows, false, adFormat);
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
    sectionLabel: { fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", textTransform: "uppercase", color: "#7e92a8", marginBottom: 10, display: "block" },
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


  // ── Auth Modal ───────────────────────────────────────────────────────────────
  const AuthModal = () => {
    const [localOptIn, setLocalOptIn] = useState(false);
    return <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", backdropFilter: "blur(8px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000, padding: 24,
    }} onClick={() => setShowAuthModal(false)}>
      <div onClick={e => e.stopPropagation()} style={{ position: "relative" }}>
        <button onClick={() => setShowAuthModal(false)} style={{
          position: "absolute", top: -12, right: -12, zIndex: 10,
          width: 28, height: 28, borderRadius: "50%", border: "none",
          background: "rgba(255,255,255,0.1)", color: "#adbccb",
          cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center",
        }}>✕</button>
        <div style={{ display: "flex", gap: 0, marginBottom: 16, background: "rgba(255,255,255,0.05)", borderRadius: 8, padding: 3 }}>
          {["sign-in", "sign-up"].map(mode => (
            <button key={mode} onClick={() => setAuthMode(mode)} style={{
              flex: 1, padding: "6px 16px", fontSize: 11, fontWeight: 700, borderRadius: 6, border: "none",
              background: authMode === mode ? "rgba(99,102,241,0.3)" : "transparent",
              color: authMode === mode ? "#a5b4fc" : "#7e92a8", cursor: "pointer",
              letterSpacing: "0.05em", textTransform: "uppercase",
            }}>{mode === "sign-in" ? "Sign In" : "Create Account"}</button>
          ))}
        </div>
        {authMode === "sign-in"
          ? <SignIn afterSignInUrl="/" routing="hash" appearance={{ variables: { colorPrimary: "#6366f1", colorBackground: "#0f172a", colorText: "#e2e8f0", colorInputBackground: "#1e293b", colorInputText: "#e2e8f0", borderRadius: "8px" } }} />
          : <SignUp afterSignUpUrl="/" routing="hash" appearance={{ variables: { colorPrimary: "#6366f1", colorBackground: "#0f172a", colorText: "#e2e8f0", colorInputBackground: "#1e293b", colorInputText: "#e2e8f0", borderRadius: "8px" } }} />
        }
        {/* Marketing opt-in — below Clerk form, unchecked by default (GDPR compliant) */}
        {authMode === "sign-up" && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 12, padding: "10px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.07)" }}>
            <button onClick={() => {
              const newVal = !localOptIn;
              setLocalOptIn(newVal);
              fetch("/api/audiences", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "set-optin", optIn: newVal }),
              }).catch(() => {});
            }} style={{
              width: 16, height: 16, borderRadius: 3, border: "none", cursor: "pointer",
              background: localOptIn ? "linear-gradient(135deg,#3b82f6,#6366f1)" : "rgba(255,255,255,0.1)",
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0, marginTop: 1, transition: "background 0.15s",
            }}>
              {localOptIn && <span style={{ color: "white", fontSize: 10, fontWeight: 900, lineHeight: 1 }}>✓</span>}
            </button>
            <span style={{ fontSize: 10, color: "#8fa3b8", lineHeight: 1.5 }}>
              I'd like to receive news, updates and tips about AI Ad Studio. You can unsubscribe at any time.
            </span>
          </div>
        )}
      </div>
    </div>
  };

  // ── Gate Modal ───────────────────────────────────────────────────────────────
  const GateModal = () => (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24,
    }}>
      <div style={{
        background: "linear-gradient(135deg,rgba(15,23,42,0.98),rgba(6,13,26,0.98))",
        border: "1px solid rgba(99,102,241,0.3)", borderRadius: 16,
        padding: "36px 32px", maxWidth: 460, width: "100%", textAlign: "center",
        boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
      }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>🚀</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: "#e2e8f0", marginBottom: 8 }}>
          Unlock unlimited access + pro tools
        </div>
        <div style={{ fontSize: 13, color: "#8fa3b8", lineHeight: 1.6, marginBottom: 24 }}>
          You've requested a pro feature or used your 10 free generations. Sign up free to keep going and unlock powerful tools built for serious advertisers.
        </div>

        {/* Feature grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 28, textAlign: "left" }}>
          {[
            { icon: "∞",  label: "Unlimited generations",       color: "#34d399" },
            { icon: "🎯", label: "Custom audience modifiers",    color: "#818cf8" },
            { icon: "📈", label: "Google Trends integration",    color: "#60a5fa" },
            { icon: "◉",  label: "Meta Ad generation",           color: "#0ea5e9" },
            { icon: "🔍", label: "Domain scan + URL import",     color: "#f59e0b" },
            { icon: "📋", label: "Export to Google / Meta",      color: "#34d399" },
          ].map(f => (
            <div key={f.label} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.06)" }}>
              <span style={{ fontSize: 14, flexShrink: 0, color: f.color }}>{f.icon}</span>
              <span style={{ fontSize: 11, color: "#adbccb", lineHeight: 1.4, fontWeight: 600 }}>{f.label}</span>
            </div>
          ))}
        </div>

        {/* Primary CTA — sign up */}
        <button
          onClick={async () => {
            // Store opt-in preference in Redis before opening Clerk
            try {
              await fetch("/api/audiences", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "set-optin", optIn: marketingOptIn }),
              });
            } catch (_) {}
            setShowGateModal(false); setAuthMode("sign-up"); setShowAuthModal(true);
          }}
          style={{
            width: "100%", padding: "13px", fontSize: 14, fontWeight: 800,
            background: "linear-gradient(135deg,#3b82f6,#6366f1)",
            color: "white", border: "none", borderRadius: 8, cursor: "pointer",
            transition: "all 0.2s", marginBottom: 10,
            boxShadow: "0 4px 20px rgba(99,102,241,0.35)",
          }}>
          Create Free Account →
        </button>

        {/* Marketing opt-in checkbox */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 14, textAlign: "left" }}>
          <button onClick={() => setMarketingOptIn(v => !v)} style={{
            width: 16, height: 16, borderRadius: 3, border: "none", cursor: "pointer",
            background: marketingOptIn ? "linear-gradient(135deg,#3b82f6,#6366f1)" : "rgba(255,255,255,0.1)",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0, marginTop: 1, transition: "background 0.15s",
          }}>
            {marketingOptIn && <span style={{ color: "white", fontSize: 10, fontWeight: 900, lineHeight: 1 }}>✓</span>}
          </button>
          <span style={{ fontSize: 10, color: "#8fa3b8", lineHeight: 1.5 }}>
            I'd like to receive news, updates and tips about AI Ad Studio. You can unsubscribe at any time.
          </span>
        </div>

        <div style={{ fontSize: 11, color: "#8fa3b8", marginBottom: 14 }}>No credit card required · Takes 30 seconds</div>

        {/* Divider */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.06)" }} />
          <span style={{ fontSize: 10, color: "#8fa3b8", letterSpacing: "0.08em" }}>ALREADY HAVE AN ACCOUNT?</span>
          <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.06)" }} />
        </div>

        {/* Secondary CTA — sign in */}
        <button
          onClick={() => { setShowGateModal(false); setAuthMode("sign-in"); setShowAuthModal(true); }}
          style={{
            width: "100%", padding: "11px", fontSize: 13, fontWeight: 700,
            background: "rgba(255,255,255,0.04)", color: "#adbccb",
            border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, cursor: "pointer",
            transition: "all 0.2s",
          }}>
          Sign in
        </button>
      </div>
    </div>
  );

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
              <div style={{ fontSize: 12, color: "#8fa3b8", lineHeight: 1.5 }}>
                {modalOmitGroup && <span style={{display:"inline-block",marginBottom:4,padding:"2px 8px",borderRadius:4,background:"rgba(99,102,241,0.15)",color:"#a5b4fc",fontSize:11,fontWeight:700}}>Campaign &amp; Ad Group columns removed</span>}<br style={{display: modalOmitGroup ? "block" : "none"}} />
                The text below is pre-selected. Press <kbd style={{ background: "#1e293b", border: "1px solid #8fa3b8", borderRadius: 4, padding: "1px 6px", fontSize: 11, color: "#adbccb" }}>Ctrl+C</kbd> (or <kbd style={{ background: "#1e293b", border: "1px solid #8fa3b8", borderRadius: 4, padding: "1px 6px", fontSize: 11, color: "#adbccb" }}>⌘C</kbd>) to copy, then paste directly into Google Ads Editor.
              </div>
            </div>
            <button onClick={() => setShowCopyModal(false)} style={{
              background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 6, color: "#adbccb", fontSize: 16, width: 30, height: 30,
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
              background: "rgba(255,255,255,0.05)", color: "#8fa3b8",
              border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, cursor: "pointer",
            }}>Close</button>
          </div>

          <div style={{ marginTop: 12, padding: "10px 12px", background: "rgba(59,130,246,0.07)", borderRadius: 8, border: "1px solid rgba(59,130,246,0.15)" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#60a5fa", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>Next steps in Google Ads Editor</div>
            {(IMPORT_STEPS[adFormat] || IMPORT_STEPS.rsa).map(s => (
              <div key={s.n} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 5 }}>
                <span style={{ fontSize: 10, fontWeight: 800, fontFamily: "monospace", color: "#3b82f6", background: "rgba(59,130,246,0.15)", borderRadius: 3, padding: "1px 5px", flexShrink: 0 }}>{s.n}</span>
                <span style={{ fontSize: 11, color: "#8fa3b8", lineHeight: 1.4 }}>{s.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  // ── Feedback score widget helper ──────────────────────────────────────────
  const ScoreWidget = ({ outputId, format, label = "Rate this output" }) => {
    if (!isSignedIn) return null;
    const fb = feedback[outputId] || {};
    const submit = async (score, comment = '') => {
      setFeedback(prev => ({ ...prev, [outputId]: { score, comment, submitted: true } }));
      setFeedbackOpen(null);
      try {
        await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'submit', userId: user.id, outputId, format, url, score, comment }),
        });
      } catch(_) {}
    };
    return (
      <div style={{ padding: '10px 16px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, color: '#4a5568', fontWeight: 700 }}>{label}</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {[1,2,3,4,5].map(s => (
            <button key={s} onClick={() => {
              submit(s);
              if (s <= 3) setFeedbackOpen(outputId);
            }} style={{
              fontSize: 16, background: 'none', border: 'none', cursor: 'pointer',
              color: (fb.score || 0) >= s ? '#f59e0b' : '#2d3748',
              transition: 'color 0.15s', padding: '0 1px',
            }}>★</button>
          ))}
        </div>
        {fb.submitted && !feedbackOpen && (
          <span style={{ fontSize: 10, color: '#34d399' }}>✓ Thanks!</span>
        )}
        {feedbackOpen === outputId && (
          <div style={{ display: 'flex', gap: 6, flex: 1, minWidth: 200 }}>
            <input
              autoFocus
              placeholder="What could be better? (optional)"
              defaultValue={fb.comment}
              onKeyDown={e => { if (e.key === 'Enter') { submit(fb.score, e.target.value); } }}
              style={{ flex: 1, padding: '4px 8px', fontSize: 11, borderRadius: 6, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#e2e8f0', outline: 'none' }}
            />
            <button onClick={e => submit(fb.score, e.target.previousSibling.value)} style={{ padding: '4px 10px', fontSize: 10, fontWeight: 700, borderRadius: 6, background: 'rgba(245,158,11,0.2)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.3)', cursor: 'pointer' }}>Send</button>
            <button onClick={() => setFeedbackOpen(null)} style={{ padding: '4px 8px', fontSize: 10, borderRadius: 6, background: 'none', color: '#4a5568', border: '1px solid rgba(255,255,255,0.07)', cursor: 'pointer' }}>Skip</button>
          </div>
        )}
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
          }}>✦</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "white", letterSpacing: "-0.01em" }}>AI Ad Studio</div>
            <div style={{ fontSize: 10, color: "#7e92a8", letterSpacing: "0.06em" }}>GOOGLE ADS AND META ADS READY</div>
          </div>
        </div>

        {/* Ad tabs */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", flex: 1, justifyContent: "center" }}>
          {rows.map((r, i) => (
            <div key={r.id} style={{ display: "flex" }}>
              <button onClick={() => setActiveRow(i)} style={{
                padding: "5px 12px", fontSize: 11, fontWeight: 700,
                background: activeRow === i ? "rgba(59,130,246,0.2)" : "transparent",
                color: activeRow === i ? "#60a5fa" : "#7e92a8",
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
            background: "transparent", color: "#7e92a8",
            border: "1px dashed rgba(255,255,255,0.12)", borderRadius: 6, cursor: "pointer",
          }}>+ Ad</button>
        </div>

        {/* Demo video + auth */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          <a href="https://www.loom.com/share/46a7ec33c1d24acea6bd01dac0775bab" target="_blank" rel="noopener noreferrer" style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "7px 14px", fontSize: 11, fontWeight: 700,
            background: "rgba(255,255,255,0.06)", color: "#e2e8f0",
            border: "1px solid rgba(255,255,255,0.1)", borderRadius: 7,
            textDecoration: "none", flexShrink: 0,
          }}>▶ Watch demo</a>
          {isAdmin && (
            <button onClick={async () => {
              const r = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'dashboard', adminKey: import.meta.env.VITE_ADMIN_KEY }) });
              const d = await r.json();
              setFeedbackDashData(d.entries || []);
              setShowFeedbackDash(true);
            }} style={{
              padding: '7px 14px', fontSize: 11, fontWeight: 700,
              background: 'rgba(99,102,241,0.12)', color: '#a5b4fc',
              border: '1px solid rgba(99,102,241,0.25)', borderRadius: 7,
              cursor: 'pointer', flexShrink: 0,
            }}>📊 Feedback</button>
          )}
          {isSignedIn && library.length > 0 && (
            <button onClick={() => setShowLibrary(true)} style={{
              padding: '7px 14px', fontSize: 11, fontWeight: 700,
              background: 'rgba(245,158,11,0.12)', color: '#fbbf24',
              border: '1px solid rgba(245,158,11,0.25)', borderRadius: 7,
              cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5,
            }}>★ Library <span style={{ background: 'rgba(245,158,11,0.3)', borderRadius: 10, padding: '1px 6px', fontSize: 9 }}>{library.length}</span></button>
          )}
                    {/* Auth button */}
          {isSignedIn ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontSize: 10, color: "#8fa3b8", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {user?.firstName || user?.emailAddresses?.[0]?.emailAddress?.split("@")[0]}
              </div>
                {isPro && <span style={{ fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 8, background: "linear-gradient(135deg,#6366f1,#0ea5e9)", color: "white", letterSpacing: "0.05em" }}>PRO</span>}
              <UserButton afterSignOutUrl="/" appearance={{ variables: { colorPrimary: "#6366f1" } }} />
            </div>
          ) : (
            <button onClick={() => { setAuthMode("sign-in"); setShowAuthModal(true); }} style={{
              padding: "7px 14px", fontSize: 11, fontWeight: 700,
              background: "linear-gradient(135deg,rgba(99,102,241,0.15),rgba(139,92,246,0.15))",
              color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.3)",
              borderRadius: 7, cursor: "pointer", whiteSpace: "nowrap",
              transition: "all 0.2s",
            }}>Sign in</button>
          )}
        </div>
      </div>

      {/* ── URL Bar ── */}
      <div style={{
        padding: "16px 24px",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        background: batchRunning
          ? "rgba(99,102,241,0.06)"
          : loading
          ? "rgba(245,158,11,0.06)"
          : "rgba(6,13,26,0.6)",
        transition: "background 0.6s ease",
      }}>
        <div style={{ maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: 1, position: "relative" }}>
            <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "#7e92a8", fontSize: 13 }}>🔗</span>
            <input
              type="url"
              value={url}
              onChange={e => { setUrl(e.target.value); setAudienceBrief(null); setAudienceBriefEdits({}); setMetaResult(null); setMetaImagesLoading(false); metaGenId.current += 1; }}
              onKeyDown={e => e.key === "Enter" && generate()}
              placeholder={batchRunning ? `Batch generating ${batchProgress.current} of ${batchProgress.total}…` : "https://yoursite.com/landing-page → press Enter or click Generate"}
              style={{
                ...S.inputBase, paddingLeft: 34, fontSize: 13,
                border: loading
                  ? "1.5px solid rgba(245,158,11,0.7)"
                  : batchRunning
                  ? "1.5px solid rgba(99,102,241,0.6)"
                  : generated
                  ? "1.5px solid rgba(59,130,246,0.4)"
                  : "1.5px solid rgba(255,255,255,0.1)",
                boxShadow: loading
                  ? "0 0 10px rgba(245,158,11,0.2)"
                  : batchRunning
                  ? "0 0 10px rgba(99,102,241,0.2)"
                  : "none",
                transition: "border 0.3s ease, box-shadow 0.3s ease",
              }}
              title="💡 Tip: Product or landing page URLs generate stronger ad copy than category pages"
            />
          </div>
          {(() => {
            const metaDisabled = batchRunning || !generated;
            const metaTooltip = batchRunning
              ? "Meta generation is disabled during batch mode — load a single ad from the history panel"
              : !generated
              ? "Generate a Google ad first, then enable Meta generation"
              : "";
            return (
              <>
                {/* Meta checkbox */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 2px", opacity: metaDisabled ? 0.4 : 1 }}
                  title={metaTooltip}>
                  <button onClick={() => !metaDisabled && setGenerateMeta(v => !v)} style={{
                    width: 16, height: 16, borderRadius: 3, border: "none",
                    cursor: metaDisabled ? "not-allowed" : "pointer", flexShrink: 0,
                    background: generateMeta && !metaDisabled ? "linear-gradient(135deg,#0ea5e9,#6366f1)" : "rgba(255,255,255,0.08)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    transition: "background 0.15s",
                    animation: generated && !generateMeta && !metaDisabled ? "metaPulse 2s ease-in-out infinite" : "none",
                    willChange: "box-shadow",
                  }}>
                    {generateMeta && !metaDisabled && <span style={{ color: "white", fontSize: 9, fontWeight: 900 }}>✓</span>}
                  </button>
                  <span style={{ fontSize: 11, color: generateMeta && !metaDisabled ? "#93c5fd" : "#4a5568",
                    cursor: metaDisabled ? "not-allowed" : "pointer", userSelect: "none" }}
                    onClick={() => !metaDisabled && setGenerateMeta(v => !v)}>
                    Also generate Meta ads <span style={{ fontSize: 10, color: "#4a5568" }}>(FB / IG)</span>
                    {batchRunning && <span style={{ fontSize: 9, color: "#4a5568", marginLeft: 6 }}>· Disabled in batch mode</span>}
                  </span>
                  {generateMeta && !metaDisabled && (
                    <div style={{ display: "flex", background: "rgba(255,255,255,0.06)", borderRadius: 6, padding: "2px 3px", gap: 2 }}>
                      {["dalle","imagen"].map(m => (
                        <button key={m} onClick={e => { e.stopPropagation(); setImageModel(m); }} style={{
                          padding: "2px 8px", fontSize: 9, fontWeight: 700, borderRadius: 4,
                          border: "none", cursor: "pointer", transition: "all 0.15s",
                          background: imageModel === m ? "linear-gradient(135deg,#6366f1,#0ea5e9)" : "transparent",
                          color: imageModel === m ? "white" : "#4a5568",
                        }}>{m === "dalle" ? "DALL-E" : "✦ Imagen"}</button>
                      ))}
                    </div>
                  )}
                </div>
                {/* TikTok checkbox */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 2px", marginTop: 2 }}>
                  <button onClick={() => isSignedIn && setGenerateTiktok(v => !v)} style={{
                    width: 16, height: 16, borderRadius: 3, border: "none",
                    cursor: isSignedIn ? "pointer" : "not-allowed", flexShrink: 0,
                    background: generateTiktok && isSignedIn ? "linear-gradient(135deg,#ff0050,#ff4d4d)" : "rgba(255,255,255,0.08)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {generateTiktok && isSignedIn && <span style={{ color: "white", fontSize: 9, fontWeight: 900 }}>✓</span>}
                  </button>
                  <span style={{ fontSize: 11, color: generateTiktok && isSignedIn ? "#fca5a5" : "#4a5568",
                    cursor: isSignedIn ? "pointer" : "not-allowed", userSelect: "none" }}
                    onClick={() => isSignedIn && setGenerateTiktok(v => !v)}>
                    Also generate TikTok ads <span style={{ fontSize: 10, color: "#4a5568" }}>(In-Feed + Video)</span>
                  </span>
                </div>
              </>
            );
          })()}
          </div>
          {/* ── Audience Brief Input ─────────────────────────────────────── */}
          {isSignedIn && (
            <div style={{ marginBottom: 8 }}>
              <textarea
                value={audienceDesc}
                onChange={e => setAudienceDesc(e.target.value)}
                placeholder="Describe your target audience (optional) — e.g. 'Active women 25-40 interested in fitness and healthy lifestyle, middle income, urban areas'"
                rows={2}
                style={{
                  width: '100%', padding: '8px 12px', fontSize: 11, borderRadius: 8,
                  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                  color: '#e2e8f0', outline: 'none', resize: 'none', lineHeight: 1.5,
                  fontFamily: 'inherit', boxSizing: 'border-box', marginBottom: 6,
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {/* Build Audience button */}
                <button onClick={async () => {
                  if (!url) return;
                  setAudienceLoading(true);
                  try {
                    // Use already-scraped pageMeta if available, else do a quick scrape
                    let pageContent = pageMeta?.content || pageMeta?.description || '';
                    if (!pageContent && url) {
                      try {
                        const scrapeRes = await fetch('/api/scrape', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
                        const scrapeData = await scrapeRes.json();
                        pageContent = scrapeData.content || scrapeData.text || '';
                      } catch(_) {}
                    }
                    const r = await fetch('/api/audience', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ url, pageContent, audienceDescription: audienceDesc }),
                    });
                    const brief = await r.json();
                    if (brief.error) {
                      console.error('Audience brief error:', brief.error);
                    } else {
                      setAudienceBrief(brief);
                      setAudienceBriefEdits({});
                      setShowAudienceBrief(true);
                    }
                  } catch(e) { console.error(e); }
                  setAudienceLoading(false);
                }} disabled={!url || audienceLoading} style={{
                  padding: '7px 14px', fontSize: 11, fontWeight: 700, borderRadius: 8, flexShrink: 0,
                  background: audienceLoading ? 'rgba(245,158,11,0.15)' : audienceBrief ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.06)',
                  color: audienceLoading ? '#fbbf24' : audienceBrief ? '#a5b4fc' : '#7e92a8',
                  border: '1px solid ' + (audienceLoading ? 'rgba(245,158,11,0.4)' : audienceBrief ? 'rgba(99,102,241,0.35)' : 'rgba(255,255,255,0.1)'),
                  cursor: !url || audienceLoading ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
                  animation: audienceLoading ? 'audiencePulse 1.5s ease-in-out infinite' : 'none',
                  willChange: 'opacity',
                }}>
                  {audienceLoading ? '⏳ Building...' : audienceBrief ? '✓ Brief ready' : '🎯 Build Audience'}
                </button>
                {audienceBrief && (
                  <button onClick={() => setShowAudienceBrief(v => !v)} style={{
                    fontSize: 10, color: '#6366f1', background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', flexShrink: 0,
                  }}>
                    {showAudienceBrief ? '▲' : '▼'}
                  </button>
                )}

                {/* Spacer */}
                <div style={{ flex: 1 }} />

                {/* New URL button — only after generation */}
                {generated && !loading && (
                  <button onClick={() => {
                    setUrl('');
                    setKeywords(['', '', '']);
                    setKwHeadlines(5);
                    setKwInDescs(false);
                    setKwDescs(1);
                    setRows([makeRow(1)]);
                    setActiveRow(0);
                    setGenerated(false);
                    setError('');
                    setActiveTab('headlines');
                    setShowModifiers(false);
                    setSeasonOn(false); setSeasonPreset(''); setSeasonCustom(''); setSeasonIntensity('Moderate');
                    setDiscountOn(false); setDiscountType('% Off'); setDiscountValue(''); setDiscountPlacement('Both');
                    setBrandOn(false); setBrandRequired(''); setBrandBanned(''); setBrandTone('Professional');
                    setClearKey(k => k + 1);
                    setAudienceDesc(''); setAdFormat('rsa');
                    setGenerateTiktok(false); setTiktokResult(null); setTiktokVideoUrl(null); setUgcVideoUrl(null);
                  }} style={{
                    padding: '9px 14px', fontSize: 11, fontWeight: 700,
                    background: 'rgba(255,255,255,0.05)',
                    color: '#8fa3b8', border: '1px solid rgba(255,255,255,0.09)',
                    borderRadius: 8, cursor: 'pointer', flexShrink: 0,
                    transition: 'all 0.2s', whiteSpace: 'nowrap',
                  }}>↺ New URL</button>
                )}

                {/* Batch button */}
                {isSignedIn && !batchRunning && (
                  <button onClick={() => setShowBatchPanel(v => !v)} style={{
                    padding: '9px 14px', fontSize: 11, fontWeight: 700,
                    background: showBatchPanel ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.05)',
                    border: '1px solid ' + (showBatchPanel ? 'rgba(99,102,241,0.35)' : 'rgba(255,255,255,0.09)'),
                    color: showBatchPanel ? '#a5b4fc' : '#7e92a8',
                    borderRadius: 8, cursor: 'pointer', flexShrink: 0,
                    transition: 'all 0.2s', whiteSpace: 'nowrap',
                  }}>⚡ Batch</button>
                )}
                {/* Generate button — signed in */}
                <button onClick={generate} disabled={loading || batchRunning} style={{
                  padding: '9px 14px', fontSize: 12, fontWeight: 700,
                  background: loading || batchRunning
                    ? 'linear-gradient(135deg,#d97706,#f59e0b)'
                    : 'linear-gradient(135deg,#3b82f6,#6366f1)',
                  color: 'white', border: 'none',
                  borderRadius: 8, cursor: loading || batchRunning ? 'not-allowed' : 'pointer',
                  display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0,
                  transition: 'background 0.3s ease, opacity 0.3s ease',
                  willChange: 'opacity',
                  animation: loading || batchRunning ? 'pulse 1.5s ease-in-out infinite' : 'none',
                }}>
                  {loading
                    ? <><span style={{ animation: 'spin 0.8s linear infinite', display: 'inline-block' }}>⟳</span> Generating…</>
                    : batchRunning
                    ? <><span style={{ animation: 'spin 0.8s linear infinite', display: 'inline-block' }}>⟳</span> Running batch…</>
                    : '✦ Generate'}
                </button>

              </div>
            </div>
          )}

          {/* Generate + New URL for non-signed-in users */}
          {!isSignedIn && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              {generated && !loading && (
                <button onClick={() => {
                  setUrl(''); setKeywords(['', '', '']); setKwHeadlines(5);
                  setKwInDescs(false); setKwDescs(1); setRows([makeRow(1)]);
                  setActiveRow(0); setGenerated(false); setError('');
                  setActiveTab('headlines'); setClearKey(k => k + 1);
                  setGenerateTiktok(false); setTiktokResult(null); setTiktokVideoUrl(null); setUgcVideoUrl(null);
                }} style={{
                  padding: '9px 14px', fontSize: 11, fontWeight: 700,
                  background: 'rgba(255,255,255,0.05)',
                  color: '#8fa3b8', border: '1px solid rgba(255,255,255,0.09)',
                  borderRadius: 8, cursor: 'pointer',
                }}>↺ New URL</button>
              )}
              <button onClick={generate} disabled={loading || batchRunning} style={{
                padding: '9px 20px', fontSize: 12, fontWeight: 700,
                background: loading || batchRunning
                  ? 'linear-gradient(135deg,#d97706,#f59e0b)'
                  : 'linear-gradient(135deg,#3b82f6,#6366f1)',
                color: 'white', border: 'none',
                borderRadius: 8, cursor: loading || batchRunning ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', gap: 7,
                transition: 'background 0.3s ease',
                animation: loading || batchRunning ? 'pulse 1.5s ease-in-out infinite' : 'none',
              }}>
                {loading
                  ? <><span style={{ animation: 'spin 0.8s linear infinite', display: 'inline-block' }}>⟳</span> Generating…</>
                  : batchRunning
                  ? <><span style={{ animation: 'spin 0.8s linear infinite', display: 'inline-block' }}>⟳</span> Running batch…</>
                  : '✦ Generate'}
              </button>
            </div>
          )}
        </div>
        {error && (
          <div style={{ maxWidth: 900, margin: "8px auto 0", fontSize: 12, color: "#f87171", display: "flex", alignItems: "center", gap: 6 }}>
            <span>⚠</span> {error}
          </div>
        )}

        {/* Batch Panel — signed-in users only */}
        {isSignedIn && showBatchPanel && (
          <div style={{ maxWidth: 900, margin: "8px auto 0", background: "rgba(15,23,42,0.8)", border: "1px solid rgba(99,102,241,0.2)", borderRadius: 12, overflow: "hidden" }}>
            {/* Header */}
            <div style={{ padding: "12px 18px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <span style={{ fontSize: 12, fontWeight: 800, color: "#e2e8f0", letterSpacing: "0.04em" }}>⚡ Batch URL Generator</span>
                <span style={{ fontSize: 10, color: "#4a5568", marginLeft: 10 }}>Paste URLs from your Google Sheet — one per line</span>
              </div>
              <button onClick={() => setShowBatchPanel(false)} style={{ background: "none", border: "none", color: "#4a5568", cursor: "pointer", fontSize: 16 }}>✕</button>
            </div>

            {batchUrls.length === 0 ? (
              /* Step 1 — Scan or Paste */
              <div style={{ padding: "0" }}>

                {/* Tab switcher */}
                <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                  {[{ id: "scan", label: "🔍 Scan Domain" }, { id: "paste", label: "📋 Paste URLs" }].map(t => (
                    <button key={t.id} onClick={() => { setBatchTab(t.id); setScanError(""); }} style={{
                      flex: 1, padding: "10px 0", fontSize: 11, fontWeight: 700,
                      background: "none", border: "none", cursor: "pointer",
                      color: batchTab === t.id ? "#a5b4fc" : "#4a5568",
                      borderBottom: batchTab === t.id ? "2px solid #6366f1" : "2px solid transparent",
                      transition: "all 0.15s",
                    }}>{t.label}</button>
                  ))}
                </div>

                {/* Scan tab */}
                {batchTab === "scan" && (
                  <div style={{ padding: "16px 18px" }}>

                    {/* Input row — always visible unless categories loaded */}
                    {scanCategories.length === 0 && scanLocales.length === 0 && (
                      <>
                        <div style={{ fontSize: 10, color: "#7e92a8", marginBottom: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                          Enter a domain to scan for product categories
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <input
                            value={scanDomain}
                            onChange={e => setScanDomain(e.target.value)}
                            onKeyDown={e => e.key === "Enter" && runScan()}
                            placeholder="e.g. hackett.com or hackett.com/de-de"
                            style={{
                              flex: 1, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                              borderRadius: 8, color: "#e2e8f0", fontSize: 12, padding: "9px 12px", outline: "none",
                            }}
                          />
                          <button onClick={() => runScan()} disabled={scanLoading || !scanDomain.trim()} style={{
                            padding: "9px 18px", borderRadius: 8, border: "none", cursor: scanLoading ? "not-allowed" : "pointer",
                            background: scanLoading ? "linear-gradient(135deg,#d97706,#f59e0b)" : "linear-gradient(135deg,#3b82f6,#6366f1)",
                            color: "white", fontWeight: 700, fontSize: 12, flexShrink: 0,
                            animation: scanLoading ? "pulse 1.5s ease-in-out infinite" : "none",
                            boxShadow: scanLoading ? "0 0 12px rgba(245,158,11,0.4)" : "none",
                          }}>
                            {scanLoading ? <><span style={{ animation: "spin 0.8s linear infinite", display: "inline-block", marginRight: 5 }}>◌</span>Scanning…</> : "Scan →"}
                          </button>
                        </div>
                        {scanError && (
                          <div style={{ marginTop: 10, padding: "8px 12px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 7 }}>
                            <div style={{ fontSize: 11, color: "#f87171", fontWeight: 700, marginBottom: 2 }}>
                              Scanner couldn't access this site
                            </div>
                            <div style={{ fontSize: 10, color: "#8fa3b8", lineHeight: 1.5 }}>{scanError}</div>
                            <button onClick={() => { setBatchTab("paste"); setScanError(""); }} style={{ marginTop: 8, fontSize: 10, fontWeight: 700, color: "#60a5fa", background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)", borderRadius: 5, cursor: "pointer", padding: "4px 10px" }}>
                              → Switch to manual paste
                            </button>
                          </div>
                        )}
                        <div style={{ marginTop: 10, fontSize: 10, color: "#2d3748" }}>
                          Works for most sites with XML sitemaps · Add /de-de to scan a specific market directly
                        </div>
                      </>
                    )}

                    {/* Locale picker — shown when multiple markets detected */}
                    {scanLocales.length > 0 && scanCategories.length === 0 && (
                      <>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                          <div>
                            <span style={{ fontSize: 11, fontWeight: 700, color: "#e2e8f0" }}>
                              {scanLocales.length} markets found
                            </span>
                            <span style={{ fontSize: 10, color: "#4a5568", marginLeft: 8 }}>via {scanMethod} · select your target market</span>
                          </div>
                          <button onClick={() => { setScanLocales([]); setScanDomain(""); }} style={{ fontSize: 10, color: "#7e92a8", background: "none", border: "none", cursor: "pointer" }}>← Re-scan</button>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 240, overflowY: "auto" }}>
                          {scanLocales.map(loc => (
                            <button key={loc.slug}
                              onClick={() => runScan(scanScannedDomain, loc.slug)}
                              disabled={scanLoading}
                              style={{
                                display: "flex", alignItems: "center", gap: 12,
                                padding: "10px 14px", borderRadius: 8, cursor: "pointer", textAlign: "left", width: "100%",
                                background: "rgba(255,255,255,0.03)",
                                border: "1px solid rgba(255,255,255,0.06)",
                                transition: "all 0.15s",
                              }}
                              onMouseEnter={e => { e.currentTarget.style.background = "rgba(99,102,241,0.08)"; e.currentTarget.style.borderColor = "rgba(99,102,241,0.25)"; }}
                              onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)"; }}
                            >
                              <span style={{ fontSize: 20, flexShrink: 0 }}>{loc.flag}</span>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0" }}>{loc.label}</div>
                                <div style={{ fontSize: 10, color: "#4a5568" }}>/{loc.slug} · {loc.count} URLs</div>
                              </div>
                              <span style={{ fontSize: 10, color: "#4a5568" }}>→</span>
                            </button>
                          ))}
                        </div>
                        {scanLoading && (
                          <div style={{ marginTop: 10, fontSize: 10, color: "#7e92a8", textAlign: "center" }}>
                            <span style={{ animation: "spin 0.8s linear infinite", display: "inline-block", marginRight: 5 }}>◌</span>
                            Scanning selected market…
                          </div>
                        )}
                      </>
                    )}

                    {/* Category picker */}
                    {scanCategories.length > 0 && (
                      <>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                          <div>
                            <span style={{ fontSize: 11, fontWeight: 700, color: "#e2e8f0" }}>{scanCategories.length} categories found</span>
                            <span style={{ fontSize: 10, color: "#4a5568", marginLeft: 8 }}>via {scanMethod}</span>
                          </div>
                          <div style={{ display: "flex", gap: 10 }}>
                            <button onClick={() => {
                              setScanCategories([]);
                              // If we have cached hreflang locales, restore them directly — no re-scan
                              if (cachedLocales.length > 0) {
                                setScanLocales(cachedLocales);
                              }
                              // If no cache, scanLocales will be empty → shows input again
                            }} style={{ fontSize: 10, color: "#7e92a8", background: "none", border: "none", cursor: "pointer" }}>🌐 Change market</button>
                            <button onClick={() => { setScanCategories([]); setScanLocales([]); setSelectedCategory(null); setScanDomain(""); }} style={{ fontSize: 10, color: "#7e92a8", background: "none", border: "none", cursor: "pointer" }}>← Re-scan</button>
                          </div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 260, overflowY: "auto" }}>
                          {scanCategories.map(cat => (
                            <button key={cat.slug} onClick={() => loadCategory(cat)} style={{
                              display: "flex", alignItems: "center", justifyContent: "space-between",
                              padding: "9px 12px", borderRadius: 8, cursor: "pointer", textAlign: "left", width: "100%",
                              background: selectedCategory?.slug === cat.slug ? "rgba(99,102,241,0.12)" : "rgba(255,255,255,0.03)",
                              border: "1px solid " + (selectedCategory?.slug === cat.slug ? "rgba(99,102,241,0.3)" : "rgba(255,255,255,0.06)"),
                              transition: "all 0.15s",
                            }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: selectedCategory?.slug === cat.slug ? "#a5b4fc" : "#cbd5e1" }}>{cat.name}</span>
                              <span style={{ fontSize: 10, color: "#4a5568", fontWeight: 700, flexShrink: 0, marginLeft: 8 }}>{cat.count} URL{cat.count !== 1 ? "s" : ""} →</span>
                            </button>
                          ))}
                        </div>
                        {selectedCategory && (
                          <div style={{ marginTop: 10, padding: "8px 12px", background: "rgba(52,211,153,0.06)", border: "1px solid rgba(52,211,153,0.15)", borderRadius: 7, fontSize: 10, color: "#6ee7b7" }}>
                            ✓ {selectedCategory.count} URLs from <strong>{selectedCategory.name}</strong> loaded — scroll down to review and generate
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* Paste tab */}
                {batchTab === "paste" && (
                  <div style={{ padding: "16px 18px" }}>
                    <div style={{ fontSize: 10, color: "#7e92a8", marginBottom: 8, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                      Run the Apps Script in Google Sheets, then paste URLs below
                    </div>
                    <textarea
                      value={batchPasteText}
                      onChange={e => setBatchPasteText(e.target.value)}
                      placeholder="https://example.com/category/shoes&#10;https://example.com/category/bags&#10;https://example.com/products/item-1"
                      style={{
                        width: "100%", height: 110, background: "rgba(255,255,255,0.03)",
                        border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8,
                        color: "#e2e8f0", fontSize: 11, padding: "10px 12px",
                        resize: "vertical", fontFamily: "monospace", boxSizing: "border-box",
                      }}
                    />
                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                      <button
                        onClick={() => { const parsed = parseBatchUrls(batchPasteText); if (parsed.length > 0) setBatchUrls(parsed); }}
                        disabled={!batchPasteText.trim()}
                        style={{
                          padding: "8px 20px", borderRadius: 8, border: "none", cursor: "pointer",
                          background: batchPasteText.trim() ? "linear-gradient(135deg,#3b82f6,#6366f1)" : "rgba(255,255,255,0.05)",
                          color: batchPasteText.trim() ? "white" : "#4a5568", fontWeight: 700, fontSize: 12,
                        }}>
                        Parse URLs →
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Select & generate step */
              <div style={{ padding: "16px 18px" }}>
                <div style={{ marginBottom: 10 }}>
                  {/* Back button row */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <button onClick={() => { setBatchUrls([]); setSelectedCategory(null); }} style={{
                      display: "flex", alignItems: "center", gap: 5,
                      fontSize: 10, fontWeight: 700, color: "#94a3b8",
                      background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 6, padding: "4px 10px", cursor: "pointer",
                    }}>← Back to categories</button>
                    {selectedCategory && (
                      <span style={{ fontSize: 10, color: "#4a5568" }}>
                        Browsing: <span style={{ color: "#a5b4fc", fontWeight: 700 }}>{selectedCategory.name}</span>
                      </span>
                    )}
                  </div>
                  {/* Step label + controls */}
                  <div style={{ fontSize: 10, color: "#7e92a8", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span>Step 2 — Select URLs to generate ({batchUrls.filter(b => b.selected).length} of {batchUrls.length} selected)</span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => setBatchUrls(prev => prev.map(b => ({ ...b, selected: true })))} style={{ fontSize: 10, fontWeight: 700, color: "#60a5fa", background: "none", border: "none", cursor: "pointer" }}>Select all</button>
                      <button onClick={() => setBatchUrls(prev => prev.map(b => ({ ...b, selected: false })))} style={{ fontSize: 10, fontWeight: 700, color: "#7e92a8", background: "none", border: "none", cursor: "pointer" }}>Clear all</button>
                      <button onClick={() => { setBatchUrls([]); setBatchPasteText(""); }} style={{ fontSize: 10, fontWeight: 700, color: "#f87171", background: "none", border: "none", cursor: "pointer" }}>← Re-paste</button>
                    </div>
                  </div>
                </div>

                {/* Grouped by category */}
                {(() => {
                  const groups = batchUrls.reduce((acc, item) => {
                    if (!acc[item.category]) acc[item.category] = [];
                    acc[item.category].push(item);
                    return acc;
                  }, {});
                  return Object.entries(groups).map(([cat, items]) => {
                    const allSelected = items.every(b => b.selected);
                    return (
                      <div key={cat} style={{ marginBottom: 12 }}>
                        {/* Category header with toggle */}
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                          <button onClick={() => setBatchUrls(prev => prev.map(b => b.category === cat ? { ...b, selected: !allSelected } : b))} style={{
                            width: 14, height: 14, borderRadius: 3, border: "none", cursor: "pointer", flexShrink: 0,
                            background: allSelected ? "linear-gradient(135deg,#3b82f6,#6366f1)" : "rgba(255,255,255,0.08)",
                            display: "flex", alignItems: "center", justifyContent: "center",
                          }}>
                            {allSelected && <span style={{ color: "white", fontSize: 8, fontWeight: 900 }}>✓</span>}
                          </button>
                          <span style={{ fontSize: 10, fontWeight: 800, color: "#a5b4fc", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                            {cat} <span style={{ color: "#4a5568", fontWeight: 400 }}>({items.length})</span>
                          </span>
                        </div>
                        {/* URL rows */}
                        {items.map((item) => {
                          const idx = batchUrls.indexOf(item);
                          return (
                            <div key={item.url} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0 5px 22px" }}>
                              <button onClick={() => setBatchUrls(prev => prev.map((b, j) => j === idx ? { ...b, selected: !b.selected } : b))} style={{
                                width: 13, height: 13, borderRadius: 3, border: "none", cursor: "pointer", flexShrink: 0,
                                background: item.selected ? "linear-gradient(135deg,#3b82f6,#6366f1)" : "rgba(255,255,255,0.08)",
                                display: "flex", alignItems: "center", justifyContent: "center",
                              }}>
                                {item.selected && <span style={{ color: "white", fontSize: 7, fontWeight: 900 }}>✓</span>}
                              </button>
                              <span style={{ fontSize: 11, color: item.selected ? "#cbd5e1" : "#4a5568", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", transition: "color 0.15s" }}>
                                {item.url}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  });
                })()}

                {/* Progress bar when running */}
                {batchRunning && (
                  <div style={{ marginTop: 12, padding: "12px 14px", background: "rgba(59,130,246,0.06)", borderRadius: 8, border: "1px solid rgba(59,130,246,0.15)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, alignItems: "center" }}>
                      <span style={{ fontSize: 11, color: "#93c5fd", fontWeight: 700 }}>
                        <span style={{ animation: "spin 0.8s linear infinite", display: "inline-block", marginRight: 6 }}>◌</span>
                        Generating {batchProgress.current} of {batchProgress.total}…
                      </span>
                      <span style={{ fontSize: 11, color: "#60a5fa", fontWeight: 800 }}>{Math.round((batchProgress.current / batchProgress.total) * 100)}%</span>
                    </div>
                    <div style={{ height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
                      <div style={{ width: `${(batchProgress.current / batchProgress.total) * 100}%`, height: "100%", background: "linear-gradient(90deg,#3b82f6,#6366f1)", borderRadius: 2, transition: "width 0.5s ease" }} />
                    </div>
                    <div style={{ fontSize: 10, color: "#4a5568", marginTop: 6 }}>
                      Results will appear in the history panel — you can export all at once when done
                    </div>
                  </div>
                )}

                {/* Generate button */}
                {!batchRunning && (
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14, gap: 10 }}>
                    <button onClick={() => { setBatchUrls([]); setBatchPasteText(""); setShowBatchPanel(false); }} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.08)", background: "none", color: "#7e92a8", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                      Cancel
                    </button>
                    <button
                      onClick={runBatchGeneration}
                      disabled={batchUrls.filter(b => b.selected).length === 0 || batchRunning}
                      style={{
                        padding: "8px 22px", borderRadius: 8, border: "none",
                        cursor: batchRunning || batchUrls.filter(b => b.selected).length === 0 ? "not-allowed" : "pointer",
                        background: batchRunning
                          ? "linear-gradient(135deg,#d97706,#f59e0b)"
                          : batchUrls.filter(b => b.selected).length > 0
                          ? "linear-gradient(135deg,#3b82f6,#6366f1)"
                          : "rgba(255,255,255,0.05)",
                        color: batchUrls.filter(b => b.selected).length > 0 ? "white" : "#4a5568",
                        fontWeight: 700, fontSize: 12,
                        boxShadow: batchRunning
                          ? "0 0 16px rgba(245,158,11,0.5)"
                          : batchUrls.filter(b => b.selected).length > 0
                          ? "0 4px 14px rgba(99,102,241,0.3)"
                          : "none",
                        animation: batchRunning ? "pulse 1.5s ease-in-out infinite" : "none",
                        transition: "background 0.3s ease, opacity 0.3s ease",
            willChange: "opacity",
                      }}>
                      {batchRunning
                        ? <><span style={{ animation: "spin 0.8s linear infinite", display: "inline-block", marginRight: 6 }}>⟳</span>Generating…</>
                        : <>✦ Generate {batchUrls.filter(b => b.selected).length} ad{batchUrls.filter(b => b.selected).length !== 1 ? "s" : ""}</>
                      }
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {isAdmin && (
          <div style={{ maxWidth: 900, margin: "6px auto 0", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 10, background: "rgba(99,102,241,0.15)", color: "#818cf8", border: "1px solid rgba(99,102,241,0.3)", letterSpacing: "0.08em" }}>⚡ ADMIN MODE</span>
            <span style={{ fontSize: 10, color: "#8fa3b8" }}>Usage gate disabled — unlimited generations</span>
          </div>
        )}
        {usageCount > 0 && !showGateModal && !isAdmin && (
          <div style={{ maxWidth: 900, margin: "6px auto 0", display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, height: 3, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${(usageCount / 10) * 100}%`, height: "100%", background: usageCount >= 8 ? "linear-gradient(90deg,#f59e0b,#ef4444)" : "linear-gradient(90deg,#3b82f6,#6366f1)", borderRadius: 2, transition: "width 0.4s" }} />
            </div>
            <span style={{ fontSize: 10, color: usageCount >= 8 ? "#f59e0b" : "#8fa3b8", fontWeight: 700, whiteSpace: "nowrap" }}>
              {usageCount}/10 free generations{usageCount >= 8 ? " — almost at limit" : ""}
            </span>
          </div>
        )}
      </div>

      {/* ── Format Tab Strip ── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "8px 24px",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        background: "rgba(6,13,26,0.7)",
      }}>
        {[
          { id: "rsa", label: "RSA", sublabel: "Search Ads", icon: "⚡" },
          { id: "pmax", label: "PMax", sublabel: "Performance Max", icon: "◈" },
          { id: "meta", label: "Meta", sublabel: "Social Ads", icon: "◉" },
          { id: "tiktok", label: "TikTok", sublabel: "Video Ads", icon: "♪" },
        ].map(fmt => (
          <button key={fmt.id} onClick={() => {
            setAdFormat(fmt.id);
          }} style={{
            display: "flex", alignItems: "center", gap: 7,
            padding: "6px 14px", borderRadius: 8, border: "none", cursor: "pointer",
            background: adFormat === fmt.id ? "rgba(99,102,241,0.2)" : "transparent",
            borderBottom: adFormat === fmt.id ? "2px solid #6366f1" : "2px solid transparent",
            transition: "all 0.15s",
          }}>
            <span style={{ fontSize: 13 }}>{fmt.icon}</span>
            <span style={{ fontSize: 12, fontWeight: 800, color: adFormat === fmt.id ? "#a5b4fc" : "#7e92a8", letterSpacing: "0.04em" }}>{fmt.label}</span>
            <span style={{ fontSize: 10, color: adFormat === fmt.id ? "#7e92a8" : "#4a5568", letterSpacing: "0.03em" }}>{fmt.sublabel}</span>
          </button>
        ))}
      </div>

      {/* ── Main 2-Col Layout ── */}
      <div style={{ flex: 1, display: "flex", gap: 0, overflow: "hidden", maxHeight: "calc(100vh - 160px)" }}>

        {/* LEFT: Edit Panel */}
        <div style={{
          width: 380, flexShrink: 0,
          borderRight: "1px solid rgba(255,255,255,0.06)",
          overflowY: "auto", padding: "20px 20px",
          background: "rgba(6,13,26,0.4)",
          display: adFormat === "tiktok" ? "none" : "block",
        }}>

          {/* Campaign / Ad Group */}
          <div style={{ marginBottom: 20 }}>
            <span style={S.sectionLabel}>Targeting</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <div style={{ fontSize: 10, color: "#7e92a8", fontWeight: 700, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>Campaign</div>
                <input value={row.campaign} onChange={e => setField("campaign", e.target.value)} placeholder="My Campaign" style={{ ...S.inputBase, fontSize: 12 }} />
              </div>
              <div>
                <div style={{ fontSize: 10, color: "#7e92a8", fontWeight: 700, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>Ad Group</div>
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
                  <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", fontSize: 9, fontWeight: 800, color: "#8fa3b8", fontFamily: "monospace" }}>K{i+1}</span>
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
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#7e92a8", textTransform: "uppercase", letterSpacing: "0.06em" }}>Headlines with keywords</div>
                    <div style={{ fontSize: 9, color: "#8fa3b8", marginTop: 1 }}>Google recommends 3–5</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <button onClick={() => setKwHeadlines(v => Math.max(1, v - 1))} style={{ width: 22, height: 22, borderRadius: 4, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#adbccb", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                    <span style={{ fontSize: 13, fontWeight: 800, color: "#e2e8f0", fontFamily: "monospace", minWidth: 20, textAlign: "center" }}>{kwHeadlines}</span>
                    <button onClick={() => setKwHeadlines(v => Math.min(10, v + 1))} style={{ width: 22, height: 22, borderRadius: 4, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#adbccb", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                  </div>
                </div>
                {/* Description toggle */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#7e92a8", textTransform: "uppercase", letterSpacing: "0.06em" }}>Include in descriptions</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {kwInDescs && (
                      <>
                        <button onClick={() => setKwDescs(v => Math.max(1, v - 1))} style={{ width: 22, height: 22, borderRadius: 4, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#adbccb", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                        <span style={{ fontSize: 13, fontWeight: 800, color: "#e2e8f0", fontFamily: "monospace", minWidth: 20, textAlign: "center" }}>{kwDescs}</span>
                        <button onClick={() => setKwDescs(v => Math.min(4, v + 1))} style={{ width: 22, height: 22, borderRadius: 4, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#adbccb", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
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
                <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.12em", textTransform: "uppercase", color: "#7e92a8" }}>Ad Copy Modifiers</span>
                {[seasonOn, discountOn, brandOn].filter(Boolean).length > 0 && (
                  <span style={{ fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 10, background: "rgba(99,102,241,0.2)", color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.3)" }}>
                    {[seasonOn, discountOn, brandOn].filter(Boolean).length} active
                  </span>
                )}
              </div>
              <span style={{ fontSize: 10, color: "#8fa3b8" }}>{showModifiers ? "▲" : "▼"}</span>
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
                      <div style={{ fontSize: 11, fontWeight: 700, color: seasonOn ? "#e2e8f0" : "#7e92a8" }}>🗓 Seasonal Messaging</div>
                      {seasonOn && seasonPreset && seasonPreset !== "Custom" ? <div style={{ fontSize: 9, color: "#6366f1", marginTop: 1 }}>{seasonPreset} · {seasonIntensity}</div>
                      : null}
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
                            color: seasonPreset === p ? "#a5b4fc" : "#7e92a8",
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
                        <span style={{ fontSize: 10, color: "#7e92a8", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", flexShrink: 0 }}>Intensity</span>
                        {["Subtle", "Moderate", "Strong"].map(level => (
                          <button key={level} onClick={() => setSeasonIntensity(level)} style={{
                            flex: 1, padding: "4px 6px", fontSize: 10, fontWeight: 700, borderRadius: 5, cursor: "pointer",
                            background: seasonIntensity === level ? "rgba(99,102,241,0.2)" : "rgba(255,255,255,0.03)",
                            color: seasonIntensity === level ? "#a5b4fc" : "#8fa3b8",
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
                      <div style={{ fontSize: 11, fontWeight: 700, color: discountOn ? "#e2e8f0" : "#7e92a8" }}>🏷 Discount & Offer</div>
                      {discountOn && discountValue ? <div style={{ fontSize: 9, color: "#34d399", marginTop: 1 }}>{discountValue} {discountType} · {discountPlacement}</div>
                      : null}
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
                          borderRadius: 8, color: "#adbccb", cursor: "pointer", flexShrink: 0,
                        }}>
                          {["% Off", "Fixed Amount", "Free Shipping", "Free Trial", "Custom"].map(t => <option key={t}>{t}</option>)}
                        </select>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ fontSize: 10, color: "#7e92a8", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", flexShrink: 0 }}>Placement</span>
                        {["Headlines only", "Descriptions only", "Both"].map(p => (
                          <button key={p} onClick={() => setDiscountPlacement(p)} style={{
                            flex: 1, padding: "4px 4px", fontSize: 9, fontWeight: 700, borderRadius: 5, cursor: "pointer",
                            background: discountPlacement === p ? "rgba(16,185,129,0.15)" : "rgba(255,255,255,0.03)",
                            color: discountPlacement === p ? "#34d399" : "#8fa3b8",
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
                      <div style={{ fontSize: 11, fontWeight: 700, color: brandOn ? "#e2e8f0" : "#7e92a8" }}>✓ Brand & Compliance</div>
                      {brandOn ? <div style={{ fontSize: 9, color: "#f59e0b", marginTop: 1 }}>{brandTone} tone{brandRequired ? " · required terms set" : ""}{brandBanned ? " · banned terms set" : ""}</div>
                      : null}
                    </div>
                    <button onClick={() => setBrandOn(v => !v)} style={{ ...({width: 36, height: 20, borderRadius: 10, border: "none", cursor: "pointer", position: "relative", transition: "background 0.2s", flexShrink: 0}), background: brandOn ? "linear-gradient(135deg,#d97706,#f59e0b)" : "rgba(255,255,255,0.08)" }}>
                      <span style={{ ...({position: "absolute", top: 2, width: 16, height: 16, borderRadius: "50%", background: "white", transition: "left 0.2s", display: "block"}), left: brandOn ? 18 : 2 }} />
                    </button>
                  </div>
                  {brandOn && (
                    <div style={{ padding: "10px 12px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", flexDirection: "column", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 2 }}>
                        <span style={{ fontSize: 10, color: "#7e92a8", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", flexShrink: 0 }}>Tone</span>
                        {["Professional", "Friendly", "Urgent", "Neutral"].map(t => (
                          <button key={t} onClick={() => setBrandTone(t)} style={{
                            flex: 1, padding: "4px 4px", fontSize: 9, fontWeight: 700, borderRadius: 5, cursor: "pointer",
                            background: brandTone === t ? "rgba(245,158,11,0.15)" : "rgba(255,255,255,0.03)",
                            color: brandTone === t ? "#f59e0b" : "#8fa3b8",
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

          {/* Audience Modifiers Panel */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button onClick={() => isSignedIn ? setShowAudiencePanel(v => !v) : (setAuthMode("sign-up"), setShowAuthModal(true))} style={{
              flex: 1, display: "flex", alignItems: "center", justifyContent: "space-between",
              background: showAudiencePanel ? "rgba(99,102,241,0.08)" : "rgba(255,255,255,0.03)",
              border: `1px solid ${showAudiencePanel ? "rgba(99,102,241,0.25)" : "rgba(255,255,255,0.07)"}`,
              borderRadius: 8, padding: "8px 12px", cursor: "pointer",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12 }}>&#127919;</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#adbccb", letterSpacing: "0.06em", textTransform: "uppercase" }}>Audience Modifiers</span>
                {!isSignedIn && <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "rgba(99,102,241,0.15)", color: "#818cf8" }}>SIGN IN</span>}
                {isSignedIn && audiences.filter(a => a.name && a.name.trim()).length > 0 && (
                  <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "rgba(99,102,241,0.15)", color: "#818cf8" }}>
                    {audiences.filter(a => a.name && a.name.trim()).length} active
                  </span>
                )}
              </div>
              <span style={{ fontSize: 10, color: "#8fa3b8" }}>{showAudiencePanel ? "▲" : "▼"}</span>
            </button>
            {/* Sticky / Session toggle */}
            {isSignedIn && (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}
                title={stickyAudiences ? "Sticky: segments persist across URLs" : "Session: segments clear on new URL"}>
                <button onClick={e => { e.stopPropagation(); setStickyAudiences(v => !v); }} style={{
                  width: 36, height: 20, borderRadius: 10, border: "none", cursor: "pointer", position: "relative",
                  background: stickyAudiences ? "linear-gradient(135deg,#6366f1,#8b5cf6)" : "rgba(255,255,255,0.08)",
                  transition: "background 0.2s",
                }}>
                  <span style={{
                    position: "absolute", top: 2, left: stickyAudiences ? 18 : 2,
                    width: 16, height: 16, borderRadius: "50%", background: "white",
                    transition: "left 0.2s", display: "block",
                  }} />
                </button>
                <span style={{ fontSize: 8, color: stickyAudiences ? "#818cf8" : "#8fa3b8", fontWeight: 700, letterSpacing: "0.04em" }}>
                  {stickyAudiences ? "STICKY" : "SESSION"}
                </span>
              </div>
            )}
          </div>
            {showAudiencePanel && isSignedIn && (
              <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontSize: 11, color: "#7e92a8", lineHeight: 1.5 }}>Define audience segments — the AI will tailor ad copy to resonate with each group.</div>
                {[0, 1].map(i => (
                  <div key={i} style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: 10 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#6366f1", marginBottom: 8, letterSpacing: "0.06em" }}>SEGMENT {i + 1}</div>
                    <input
                      placeholder={"Audience name (e.g. Young Professionals)"}
                      value={(audiences[i] && audiences[i].name) || ""}
                      onChange={e => {
                        const updated = [...audiences];
                        if (!updated[i]) updated[i] = { name: "", painPoints: "", tone: "Professional" };
                        updated[i] = Object.assign({}, updated[i], { name: e.target.value });
                        setAudiences(updated);
                      }}
                      style={{ width: "100%", padding: "7px 10px", fontSize: 11, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: "white", outline: "none", boxSizing: "border-box", marginBottom: 6, fontFamily: "inherit" }}
                    />
                    <textarea
                      placeholder={"Pain points & motivations (e.g. time-poor, value conscious)"}
                      value={(audiences[i] && audiences[i].painPoints) || ""}
                      onChange={e => {
                        const updated = [...audiences];
                        if (!updated[i]) updated[i] = { name: "", painPoints: "", tone: "Professional" };
                        updated[i] = Object.assign({}, updated[i], { painPoints: e.target.value });
                        setAudiences(updated);
                      }}
                      rows={2}
                      style={{ width: "100%", padding: "7px 10px", fontSize: 11, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: "white", outline: "none", boxSizing: "border-box", resize: "none", fontFamily: "inherit", marginBottom: 6 }}
                    />
                    <div style={{ display: "flex", gap: 4 }}>
                      {["Professional", "Friendly", "Urgent", "Empathetic"].map(t => (
                        <button key={t} onClick={() => {
                          const updated = [...audiences];
                          if (!updated[i]) updated[i] = { name: "", painPoints: "", tone: t };
                          updated[i] = Object.assign({}, updated[i], { tone: t });
                          setAudiences(updated);
                        }} style={{
                          flex: 1, padding: "4px 2px", fontSize: 9, fontWeight: 700, borderRadius: 5, cursor: "pointer",
                          background: ((audiences[i] && audiences[i].tone) || "Professional") === t ? "rgba(99,102,241,0.15)" : "rgba(255,255,255,0.03)",
                          color: ((audiences[i] && audiences[i].tone) || "Professional") === t ? "#818cf8" : "#8fa3b8",
                          border: "1px solid " + (((audiences[i] && audiences[i].tone) || "Professional") === t ? "rgba(99,102,241,0.3)" : "rgba(255,255,255,0.06)"),
                        }}>{t}</button>
                      ))}
                    </div>
                  </div>
                ))}
                <div style={{ background: "rgba(255,255,255,0.01)", border: "1px dashed rgba(255,255,255,0.08)", borderRadius: 8, padding: 10, opacity: 0.5 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#8fa3b8", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                    SEGMENT 3 <span style={{ fontSize: 9, padding: "1px 6px", borderRadius: 4, background: "rgba(245,158,11,0.1)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.2)" }}>PRO</span>
                  </div>
                  <div style={{ fontSize: 11, color: "#8fa3b8" }}>Unlock unlimited audience segments with a Pro account</div>
                </div>
              </div>
            )}
          </div>

          {/* Google Trends Panel */}
          {isSignedIn && trends.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <button onClick={() => setShowTrendsPanel(v => !v)} style={{
                width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                background: showTrendsPanel ? "rgba(16,185,129,0.08)" : "rgba(255,255,255,0.03)",
                border: "1px solid " + (showTrendsPanel ? "rgba(16,185,129,0.25)" : "rgba(255,255,255,0.07)"),
                borderRadius: 8, padding: "8px 12px", cursor: "pointer", marginBottom: showTrendsPanel ? 10 : 0,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12 }}>&#128200;</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#adbccb", letterSpacing: "0.06em", textTransform: "uppercase" }}>Search Angles</span>
                  {trendsLoading && <span style={{ fontSize: 9, color: "#7e92a8" }}>fetching...</span>}
                  {selectedTrends.length > 0 && (
                    <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "rgba(16,185,129,0.15)", color: "#34d399" }}>
                      {selectedTrends.length} injected
                    </span>
                  )}
                </div>
                <span style={{ fontSize: 10, color: "#8fa3b8" }}>{showTrendsPanel ? "A" : "V"}</span>
              </button>
              {showTrendsPanel && (
                <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 11, color: "#7e92a8", marginBottom: 10, lineHeight: 1.5 }}>AI-suggested search angles for this product. Click to inject into your next generation.</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {trends.map(t => {
                      const active = selectedTrends.includes(t);
                      return (
                        <button key={t} onClick={() => setSelectedTrends(prev => active ? prev.filter(x => x !== t) : [...prev, t])} style={{
                          padding: "5px 10px", fontSize: 11, fontWeight: 600, borderRadius: 20, cursor: "pointer",
                          background: active ? "rgba(16,185,129,0.15)" : "rgba(255,255,255,0.04)",
                          color: active ? "#34d399" : "#8fa3b8",
                          border: "1px solid " + (active ? "rgba(16,185,129,0.35)" : "rgba(255,255,255,0.08)"),
                          transition: "all 0.15s",
                        }}>
                          {active ? "checked " : "+ "}{t}
                        </button>
                      );
                    })}
                  </div>
                  {selectedTrends.length > 0 && (
                    <div style={{ marginTop: 8, fontSize: 10, color: "#8fa3b8" }}>Selected trends will be woven into your next generation</div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Edit Accordion ── */}
          {editOpen && (<>
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
                color: activeTab === t.id ? "#60a5fa" : "#7e92a8",
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
                  key={`${clearKey}-h-${i}`}
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
              {row.descriptions.map((d, i) => {
                const qa = d.text ? scoreDescription(d.text) : { score: "good", flags: [] };
                const dotColor = !d.text ? "#2d3748" : qa.score === "error" ? "#f87171" : qa.score === "warn" ? "#fbbf24" : "#34d399";
                const labelWithDot = (
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    {`D${i + 1}`}
                    {d.text && <span style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor, display: "inline-block", flexShrink: 0 }} title={qa.flags.join(", ") || "OK"} />}
                  </span>
                );
                return (
                  <div key={`desc-${i}`}>
                    {qa.score !== "good" && d.text && qa.flags.length > 0 && (
                      <div style={{ display: "flex", gap: 4, marginBottom: 3, flexWrap: "wrap" }}>
                        {qa.flags.map(f => (
                          <span key={f} style={{
                            fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 10,
                            background: qa.score === "error" ? "rgba(239,68,68,0.12)" : "rgba(245,158,11,0.12)",
                            color: qa.score === "error" ? "#f87171" : "#fbbf24",
                            border: `1px solid ${qa.score === "error" ? "rgba(239,68,68,0.25)" : "rgba(245,158,11,0.25)"}`,
                          }}>{f}</span>
                        ))}
                      </div>
                    )}
                    <EditableField
                      label={labelWithDot}
                      value={d.text}
                      limit={DESC_LIMIT}
                      onChange={v => setDesc(i, "text", v)}
                      pinValue={d.pin}
                      onPinChange={v => setDesc(i, "pin", v)}
                      isDesc={true}
                      refineContext={{ url, language: pageMeta?.language || "English" }}
                    />
                  </div>
                );
              })}
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
          </>)}{/* end edit accordion */}
        </div>

        {/* RIGHT: Preview Panel */}
        <div id="right-panel" style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: adFormat === "tiktok" ? "none" : "flex", flexDirection: "column", gap: 20 }}>

        {adFormat === "pmax" ? (
          /* ── PMax Output Panel ── */
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

            {/* PMax empty state */}
            {!rows[activeRow]?.pmaxResult && !loading && (
              <div style={{ textAlign: "center", padding: "40px 20px", color: "#4a5568" }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>◈</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#7e92a8", marginBottom: 6 }}>PMax Asset Group</div>
                <div style={{ fontSize: 12, color: "#4a5568", marginBottom: 16 }}>Enter a URL and generate to create your Performance Max assets</div>
                {/* Cross-format import — only show if RSA has been generated */}
                {generated && rows[activeRow]?.headlines?.some(h => h.text) && (
                  <button onClick={() => {
                    const r = rows[activeRow];
                    const rsaHeadlines = r.headlines.filter(h => h.text).map(h => h.text);
                    const rsaDescs = r.descriptions.filter(d => d.text).map(d => d.text);
                    updateRow(activeRow, row => ({
                      ...row,
                      pmaxResult: {
                        businessName: "",
                        headlines: [...rsaHeadlines.slice(0, 15), ...Array(Math.max(0, 15 - rsaHeadlines.length)).fill("")],
                        longHeadlines: Array(5).fill(""),
                        descriptions: rsaDescs.slice(0, 5),
                        callToAction: "Shop Now",
                      }
                    }));
                  }} style={{
                    padding: "9px 18px", borderRadius: 8, border: "1px solid rgba(99,102,241,0.3)",
                    background: "rgba(99,102,241,0.1)", color: "#a5b4fc",
                    fontSize: 11, fontWeight: 700, cursor: "pointer",
                  }}>
                    ⚡ Use RSA as starting point
                  </button>
                )}
              </div>
            )}

            {/* PMax loading */}
            {loading && (
              <div style={{ textAlign: "center", padding: "60px 20px" }}>
                <div style={{ fontSize: 12, color: "#7e92a8" }}>Generating PMax assets…</div>
              </div>
            )}

            {/* PMax Result */}
            {rows[activeRow]?.pmaxResult && (() => {
              const p = rows[activeRow].pmaxResult;
              const SectionLabel = ({ children }) => (
                <div style={{ fontSize: 10, fontWeight: 700, color: "#7e92a8", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>{children}</div>
              );
              const AssetRow = ({ text, limit, color = "#a5b4fc" }) => {
                const len = text?.length || 0;
                const over = len > limit;
                return (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 6, marginBottom: 4, border: `1px solid ${over ? "rgba(239,68,68,0.3)" : "rgba(255,255,255,0.06)"}` }}>
                    <span style={{ fontSize: 12, color: over ? "#f87171" : "#e2e8f0", flex: 1 }}>{text}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: over ? "#f87171" : "#4a5568", flexShrink: 0 }}>{len}/{limit}</span>
                  </div>
                );
              };
              return (
                <>
                  {/* Business Name + Logo */}
                  <div style={{ background: "rgba(15,23,42,0.6)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "16px 18px" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                      <SectionLabel>Business Name</SectionLabel>
                      {pmaxLogo && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <img src={pmaxLogo} alt="logo" style={{ width: 28, height: 28, borderRadius: 4, objectFit: "contain", background: "rgba(255,255,255,0.05)", padding: 2 }}
                            onError={() => setPmaxLogo(null)} />
                          <span style={{ fontSize: 9, color: "#4a5568" }}>Auto-fetched logo</span>
                        </div>
                      )}
                    </div>
                    <AssetRow text={p.businessName} limit={25} color="#34d399" />
                  </div>

                  {/* Headlines */}
                  <div style={{ background: "rgba(15,23,42,0.6)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "16px 18px" }}>
                    <SectionLabel>Headlines (30 chars)</SectionLabel>
                    {(p.headlines || []).map((h, i) => <AssetRow key={i} text={h} limit={30} />)}
                  </div>

                  {/* Long Headlines */}
                  <div style={{ background: "rgba(15,23,42,0.6)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "16px 18px" }}>
                    <SectionLabel>Long Headlines (90 chars)</SectionLabel>
                    {(p.longHeadlines || []).map((h, i) => <AssetRow key={i} text={h} limit={i === 0 ? 60 : 90} color="#34d399" />)}
                  </div>

                  {/* Descriptions */}
                  <div style={{ background: "rgba(15,23,42,0.6)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "16px 18px" }}>
                    <SectionLabel>Descriptions (90 chars)</SectionLabel>
                    {(p.descriptions || []).map((d, i) => <AssetRow key={i} text={d} limit={90} color="#fb923c" />)}
                  </div>

                  {/* Call to Action */}
                  <div style={{ background: "rgba(15,23,42,0.6)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "16px 18px" }}>
                    <SectionLabel>Call to Action</SectionLabel>
                    <div style={{ display: "inline-flex", alignItems: "center", padding: "6px 14px", background: "rgba(99,102,241,0.2)", borderRadius: 20, border: "1px solid rgba(99,102,241,0.3)" }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "#a5b4fc" }}>{p.callToAction || "Shop Now"}</span>
                    </div>
                  </div>

                  {/* Copy Button */}
                  <button onClick={() => {
                    // Build TSV row matching PMAX_TSV_HEADERS
                    const lhPadded = [...(p.longHeadlines || []).slice(0,5), ...Array(Math.max(0,5-(p.longHeadlines||[]).length)).fill("")]
                    const hlPadded = [...(p.headlines || []).slice(0,15), ...Array(Math.max(0,15-(p.headlines||[]).length)).fill("")]
                    const dPadded = [...(p.descriptions || []).slice(0,5), ...Array(Math.max(0,5-(p.descriptions||[]).length)).fill("")]
                    const hdr = ["Asset Group","Business Name",...Array.from({length:15},(_,i)=>`Headline ${i+1}`),...Array.from({length:5},(_,i)=>`Long Headline ${i+1}`),...Array.from({length:5},(_,i)=>`Description ${i+1}`),"Call to Action","Final URL"].join("\t");
                    const row = [rows[activeRow]?.adGroup||"Asset Group 1", p.businessName||"", ...hlPadded, ...lhPadded, ...dPadded, p.callToAction||"", rows[activeRow]?.finalUrl||""].join("\t");
                    const txt = hdr + "\n" + row;
                    navigator.clipboard.writeText(txt);
                  }} style={{
                    width: "100%", padding: "10px 0", borderRadius: 8, border: "none",
                    background: "linear-gradient(135deg,#3b82f6,#6366f1)",
                    color: "white", fontSize: 12, fontWeight: 700, cursor: "pointer",
                  }}>
                    Copy All Assets
                  </button>

                  {/* ── Image Assets Accordion ── */}
                  {isSignedIn && (
                    <div style={{ marginTop: 8 }}>
                      <button onClick={() => setShowImagePanel(v => !v)} style={{
                        width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                        background: showImagePanel ? "rgba(16,185,129,0.08)" : "rgba(255,255,255,0.03)",
                        border: "1px solid " + (showImagePanel ? "rgba(16,185,129,0.25)" : "rgba(255,255,255,0.08)"),
                        borderRadius: 10, padding: "12px 16px", cursor: "pointer", transition: "all 0.2s",
                      }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 14 }}>🎨</span>
                          <div style={{ textAlign: "left" }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: showImagePanel ? "#34d399" : "#e2e8f0" }}>
                              Generate Visuals for this PMax Ad
                            </div>
                            <div style={{ fontSize: 10, color: "#7e92a8", marginTop: 1 }}>
                              Upload a brand image → AI generates landscape, square & portrait formats
                            </div>
                          </div>
                        </div>
                        <span style={{ fontSize: 10, color: "#7e92a8", transition: "transform 0.2s", transform: showImagePanel ? "rotate(180deg)" : "rotate(0deg)" }}>▼</span>
                      </button>

                      {showImagePanel && (
                        <div style={{ padding: "16px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderTop: "none", borderRadius: "0 0 10px 10px" }}>

                          {/* Upload area */}
                          {(() => {
                            const fileInputRef = { current: null };
                            const handleFileChange = e => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              if (file.size > 5 * 1024 * 1024) { alert("Image must be under 5MB"); return; }
                              setImageFile(file);
                              const reader = new FileReader();
                              reader.onload = ev => setImagePreview(ev.target.result);
                              reader.readAsDataURL(file);
                              setGeneratedImages([]);
                            };
                            return (
                              <div style={{ marginBottom: 14 }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: "#7e92a8", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
                                  Brand / Product Image
                                </div>
                                <input
                                  ref={el => fileInputRef.current = el}
                                  type="file"
                                  accept="image/jpeg,image/png,image/webp"
                                  style={{ display: "none" }}
                                  onChange={handleFileChange}
                                />
                                <div
                                  onClick={() => fileInputRef.current?.click()}
                                  style={{
                                    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                                    gap: 8, padding: "20px 16px",
                                    border: "2px dashed " + (imagePreview ? "rgba(52,211,153,0.4)" : "rgba(255,255,255,0.12)"),
                                    borderRadius: 10, cursor: "pointer", transition: "all 0.2s",
                                    background: imagePreview ? "rgba(16,185,129,0.05)" : "rgba(255,255,255,0.02)",
                                  }}>
                                  {imagePreview ? (
                                    <img src={imagePreview} alt="preview" style={{ maxHeight: 120, maxWidth: "100%", borderRadius: 6, objectFit: "contain" }} />
                                  ) : (
                                    <>
                                      <span style={{ fontSize: 24 }}>📁</span>
                                      <span style={{ fontSize: 11, color: "#7e92a8", textAlign: "center" }}>Click to upload brand or product image<br /><span style={{ fontSize: 10, color: "#4a5568" }}>JPG, PNG, WEBP · max 5MB</span></span>
                                    </>
                                  )}
                                </div>
                                {imagePreview && (
                                  <button onClick={() => { setImageFile(null); setImagePreview(null); setGeneratedImages([]); }}
                                    style={{ marginTop: 6, fontSize: 10, color: "#7e92a8", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
                                    Remove image
                                  </button>
                                )}
                              </div>
                            );
                          })()}

                          {/* Creative Style selector */}
                          <div style={{ marginBottom: 14 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: "#7e92a8", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>
                              Creative Style
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              {[
                                { id: "match",     icon: "🎯", label: "Match URL style",    desc: "Recreate the visual style found on the landing page" },
                                { id: "studio",    icon: "📸", label: "Studio",             desc: "Clean studio setting, model or product on neutral background" },
                                { id: "lifestyle", icon: "🌿", label: "Lifestyle",           desc: "Product shown in real-life situations and environments" },
                                { id: "other",     icon: "✏️",  label: "Custom direction",   desc: null },
                              ].map(opt => (
                                <button key={opt.id} onClick={() => setCreativeStyle(opt.id)} style={{
                                  display: "flex", alignItems: "center", gap: 10,
                                  padding: "9px 12px", borderRadius: 8, border: "none", cursor: "pointer",
                                  background: creativeStyle === opt.id ? "rgba(99,102,241,0.15)" : "rgba(255,255,255,0.03)",
                                  borderLeft: "3px solid " + (creativeStyle === opt.id ? "#6366f1" : "transparent"),
                                  transition: "all 0.15s", textAlign: "left",
                                }}>
                                  <span style={{ fontSize: 14, flexShrink: 0 }}>{opt.icon}</span>
                                  <div>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: creativeStyle === opt.id ? "#a5b4fc" : "#e2e8f0" }}>{opt.label}</div>
                                    {opt.desc ? <div style={{ fontSize: 10, color: "#7e92a8", marginTop: 1 }}>{opt.desc}</div>
                                    : null}
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* Free text guidance — always shown for Other, optional hint for others */}
                          <div style={{ marginBottom: 14 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: "#7e92a8", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>
                              {creativeStyle === "other" ? "Your Creative Direction" : "Additional Notes"} <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>{creativeStyle !== "other" && "(optional)"}</span>
                            </div>
                            <input
                              value={imageGuidance}
                              onChange={e => setImageGuidance(e.target.value)}
                              placeholder={
                                creativeStyle === "match" ? "e.g. emphasise the summer collection..." :
                                creativeStyle === "studio" ? "e.g. white background, female model, standing pose..." :
                                creativeStyle === "lifestyle" ? "e.g. outdoor beach setting, sunny day, casual mood..." :
                                "Describe your creative vision..."
                              }
                              style={{ ...S.inputBase, fontSize: 11, width: "100%" }}
                            />
                          </div>

                          {/* Generate button */}
                          <button
                            disabled={!imageFile || imageLoading}
                            onClick={async () => {
                              if (!imageFile) return;
                              setImageLoading(true);
                              setGeneratedImages([]);
                              try {
                                const reader = new FileReader();
                                reader.onload = async (ev) => {
                                  const dataUrl = ev.target.result;
                                  const base64 = dataUrl.split(",")[1];
                                  const mediaType = imageFile.type;
                                  const imgRes = await fetch("/api/image-gen", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({
                                      imageBase64: base64,
                                      mediaType,
                                      siteName: pageMeta?.siteName,
                                      title: pageMeta?.title,
                                      h1: pageMeta?.h1,
                                      language: pageMeta?.language,
                                      creativeStyle,
                                      userGuidance: imageGuidance,
                                    }),
                                  });
                                  const imgData = await imgRes.json();
                                  if (imgData.images) {
                                    setGeneratedImages(imgData.images);
                                    setImageAnalysis(imgData.analysis);
                                  } else {
                                    alert("Image generation failed — " + (imgData.error || "unknown error"));
                                  }
                                  setImageLoading(false);
                                };
                                reader.readAsDataURL(imageFile);
                              } catch (e) {
                                alert("Error: " + e.message);
                                setImageLoading(false);
                              }
                            }}
                            style={{
                              width: "100%", padding: "10px 0", borderRadius: 8, border: "none",
                              background: imageFile && !imageLoading ? "linear-gradient(135deg,#059669,#0d9488)" : "rgba(255,255,255,0.06)",
                              color: imageFile && !imageLoading ? "white" : "#4a5568",
                              fontSize: 12, fontWeight: 700, cursor: imageFile && !imageLoading ? "pointer" : "not-allowed",
                              transition: "all 0.2s",
                            }}>
                            {imageLoading ? "⏳ Generating 3 formats…" : "🎨 Generate PMax Visuals"}
                          </button>

                          {/* Analysis badge */}
                          {imageAnalysis && (
                            <div style={{ marginTop: 10, padding: "8px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 8, fontSize: 10, color: "#7e92a8" }}>
                              <span style={{ color: "#34d399", fontWeight: 700 }}>✓ Style detected: </span>
                              {imageAnalysis.style} · {imageAnalysis.mood} · {imageAnalysis.colorPalette}
                            </div>
                          )}

                          {/* Generated images */}
                          {generatedImages.length > 0 && (
                            <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 16 }}>
                              {generatedImages.map(img => (
                                <div key={img.id} style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, overflow: "hidden" }}>
                                  <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                                    <div>
                                      <span style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0" }}>{img.label}</span>
                                      <span style={{ fontSize: 10, color: "#7e92a8", marginLeft: 8 }}>{img.ratio} · {img.dims}</span>
                                    </div>
                                    {img.imageUrl && (
                                      <a href={img.imageUrl} download={`pmax-${img.id}.jpg`} target="_blank" rel="noopener noreferrer"
                                        style={{ fontSize: 10, fontWeight: 700, color: "#60a5fa", textDecoration: "none", padding: "4px 10px", background: "rgba(96,165,250,0.1)", borderRadius: 6, border: "1px solid rgba(96,165,250,0.2)" }}>
                                        ⬇ Download
                                      </a>
                                    )}
                                  </div>
                                  {img.imageUrl ? (
                                    <img src={img.imageUrl} alt={img.label} style={{ width: "100%", display: "block", maxHeight: 220, objectFit: "cover" }} />
                                  ) : (
                                    <div style={{ padding: 20, textAlign: "center", color: "#7e92a8", fontSize: 11 }}>
                                      ⚠ {img.error || "Generation failed for this format"}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}

                        </div>
                      )}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        ) : (
          /* ── RSA Output (existing) ── */
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

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
                    <div style={{ fontSize: 10, color: "#7e92a8", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{stat.label}</div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: stat.ok ? "#34d399" : "#e2e8f0" }}>{stat.val}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* SERP Preview — hidden when Meta tab active */}
          {adFormat !== "meta" && (<><div style={S.card}>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ ...S.sectionLabel, margin: 0 }}>Google SERP Preview</span>
              <button onClick={() => setEditOpen(v => !v)} style={{ fontSize: 10, fontWeight: 700, padding: '4px 10px', borderRadius: 6, border: editOpen ? '1px solid rgba(99,102,241,0.4)' : '1px solid rgba(255,255,255,0.09)', background: editOpen ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.04)', color: editOpen ? '#a5b4fc' : '#7e92a8', cursor: 'pointer', transition: 'all 0.15s' }}>
                {editOpen ? '✕ Close editor' : '✎ Edit this ad'}
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 10, color: "#8fa3b8", fontStyle: "italic" }}>Shows first 3 headlines · first 2 descriptions</span>
                {rows.filter(r => r.headlines.some(h => h.text)).length > 1 && (
                  <button onClick={() => setShowAdSwitcher(v => !v)} style={{
                    fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 6,
                    background: showAdSwitcher ? "rgba(99,102,241,0.2)" : "rgba(255,255,255,0.05)",
                    border: "1px solid " + (showAdSwitcher ? "rgba(99,102,241,0.35)" : "rgba(255,255,255,0.08)"),
                    color: showAdSwitcher ? "#a5b4fc" : "#7e92a8", cursor: "pointer", whiteSpace: "nowrap",
                  }}>
                    {showAdSwitcher ? "▲" : "▼"} View all {rows.filter(r => r.headlines.some(h => h.text)).length} ads
                  </button>
                )}
              </div>
            </div>

            {/* Ad Switcher Accordion */}
            {showAdSwitcher && (
              <div style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", padding: "8px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
                {(() => {
                  const validRows = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.headlines.some(h => h.text));
                  const pageRows = validRows.slice(switcherPage * ADS_PER_PAGE, (switcherPage + 1) * ADS_PER_PAGE);
                  return (
                    <>
                      {pageRows.map(({ r, i }) => {
                        const isActive = i === activeRow;
                        const label = r.adGroup || r.campaign || (() => { try { return new URL(r.finalUrl || "").hostname; } catch { return "Ad " + (i + 1); } })();
                        const headline = r.headlines.find(h => h.text)?.text || "—";
                        return (
                          <button key={r.id} onClick={() => { setActiveRow(i); setUrl(r.finalUrl || ""); }} style={{
                            display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
                            borderRadius: 7, border: "1px solid " + (isActive ? "rgba(99,102,241,0.35)" : "rgba(255,255,255,0.05)"),
                            background: isActive ? "rgba(99,102,241,0.1)" : "rgba(255,255,255,0.02)",
                            cursor: "pointer", textAlign: "left", transition: "all 0.15s", width: "100%",
                          }}>
                            <div style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: isActive ? "#818cf8" : "rgba(255,255,255,0.15)" }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 10, fontWeight: 700, color: isActive ? "#a5b4fc" : "#7e92a8", marginBottom: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
                              <div style={{ fontSize: 11, color: isActive ? "#e2e8f0" : "#4a5568", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{headline}</div>
                            </div>
                            {isActive && <span style={{ fontSize: 9, color: "#818cf8", fontWeight: 700, flexShrink: 0 }}>ACTIVE</span>}
                          </button>
                        );
                      })}
                      <Paginator page={switcherPage} total={validRows.length} perPage={ADS_PER_PAGE} onChange={p => setSwitcherPage(p)} />
                    </>
                  );
                })()}
              </div>
            )}

            <div style={{ padding: "18px" }}>
              <SerpPreview row={row} favicon={pmaxLogo} />
            </div>
            {/* Headline rotation hint */}
            {row.headlines.filter(h => h.text.trim()).length > 3 && (
              <div style={{ padding: "0 18px 14px", fontSize: 11, color: "#8fa3b8", display: "flex", alignItems: "center", gap: 5 }}>
                <span>⟳</span> Google will rotate all {row.headlines.filter(h => h.text.trim()).length} headlines automatically
              </div>
            )}
          </div></>)}
          {generated && adFormat !== 'meta' && (
            <div style={{ fontSize: 10, color: '#2d3748', padding: '4px 2px', display: 'flex', gap: 5, alignItems: 'flex-start' }}>
              <span>⚠️</span><span>AI-generated copy may contain errors. Always review before importing. You are responsible for final ad content.</span>
            </div>
          )}

          {/* All Headlines grid preview */}
          {/* All Headlines grid preview — hidden on Meta tab */}
          {adFormat !== 'meta' && generated && (
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
                      color: over ? "#f87171" : "#adbccb",
                      display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8,
                    }}>
                      <span style={{ color: "#7e92a8", fontSize: 10, flexShrink: 0, marginTop: 1 }}>D{i + 1}</span>
                      <span style={{ flex: 1 }}>{d.text}</span>
                      <span style={{ fontSize: 10, fontFamily: "monospace", color: charInfo(d.text, DESC_LIMIT, true).color, flexShrink: 0 }} title={charInfo(d.text, DESC_LIMIT, true).grace ? "Slightly over — tolerated" : ""}>{d.text.length}{charInfo(d.text, DESC_LIMIT, true).grace ? "⚠" : ""}</span>
                    </div>
                  ) : null;
                })}
              </div>
            </div>
          )}

          {/* Meta FB/IG Feed Preview */}
          {adFormat === 'meta' && metaResult && (
            <>
            <div style={S.card}>
              <div style={{ padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ ...S.sectionLabel, margin: 0 }}>Meta Ad Preview</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['fb-feed','ig-feed'].map(fmt => (
                    <button key={fmt} onClick={() => setMetaPreviewFormat(fmt)} style={{
                      fontSize: 9, fontWeight: 700, padding: '2px 8px', borderRadius: 5,
                      border: 'none', cursor: 'pointer',
                      background: metaPreviewFormat === fmt ? 'linear-gradient(135deg,#0ea5e9,#6366f1)' : 'rgba(255,255,255,0.06)',
                      color: metaPreviewFormat === fmt ? 'white' : '#4a5568',
                    }}>{fmt === 'fb-feed' ? 'Facebook' : 'Instagram'}</button>
                  ))}
                </div>
              </div>
              <div style={{ padding: '16px' }}>
                {/* FB/IG Feed Card */}
                <div style={{ background: '#fff', borderRadius: 10, overflow: 'hidden', maxWidth: 380, margin: '0 auto', boxShadow: '0 2px 12px rgba(0,0,0,0.3)' }}>
                  {/* Page header */}
                  <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'linear-gradient(135deg,#3b82f6,#6366f1)', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {pmaxLogo ? <img src={pmaxLogo} alt='' style={{ width: '100%', height: '100%', objectFit: 'contain' }} onError={e => e.currentTarget.style.display='none'} /> : <span style={{ color: 'white', fontSize: 16, fontWeight: 800 }}>{(rows[activeRow]?.campaign || url || 'B').charAt(0).toUpperCase()}</span>}
                    </div>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#1a1a1a' }}>{(() => { try { const h = new URL(url).hostname.replace('www.','').split('.')[0]; return h.charAt(0).toUpperCase() + h.slice(1); } catch(_) { return rows[activeRow]?.campaign || 'Brand'; } })()}</div>
                      <div style={{ fontSize: 10, color: '#8a8a8a' }}>Sponsored · {metaPreviewFormat === 'fb-feed' ? '🌐' : '📱'}</div>
                    </div>
                  </div>
                  {/* Primary text */}
                  <div style={{ padding: '0 12px 10px', fontSize: 13, color: '#1a1a1a', lineHeight: 1.5 }}>
                    {(() => { const t = metaEdits[`pt-${metaActiveVariants.pt}`] !== undefined ? metaEdits[`pt-${metaActiveVariants.pt}`] : (metaResult.primaryTexts?.[metaActiveVariants.pt] || ''); return t.slice(0, 120) + (t.length > 120 ? '... See more' : ''); })()}
                  </div>
                  {/* Ad image */}
                  {metaImagesLoading && !metaResult.imageUrl && (
                    <div style={{ width: '100%', aspectRatio: '1', background: 'linear-gradient(135deg, #1a1a2e, #16213e)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: 20, animation: 'spin 2s linear infinite' }}>✦</div>
                      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>Generating image…</div>
                    </div>
                  )}
                  {metaResult.imageUrl && (
                    <img src={metaResult.imageUrl} alt='Meta ad' style={{ width: '100%', aspectRatio: '1', objectFit: 'contain', background: '#f0f2f5', display: 'block' }} />
                  )}
                  {/* TikTok hint */}
                  {generateTiktok && tiktokResult && !tiktokLoading && (
                    <div onClick={() => { setAdFormat("tiktok"); setTimeout(() => { const rp = document.getElementById("right-panel"); if (rp) rp.scrollTo({ top: rp.scrollHeight, behavior: "smooth" }); }, 300); }}
                      style={{ padding: '7px 12px', background: 'linear-gradient(135deg,rgba(255,0,80,0.12),rgba(255,77,77,0.08))', borderTop: '1px solid rgba(255,77,77,0.2)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13 }}>♪</span>
                      <span style={{ fontSize: 10, color: '#fca5a5', fontWeight: 700 }}>TikTok ad ready — tap to view</span>
                      <span style={{ fontSize: 10, color: 'rgba(255,165,165,0.5)', marginLeft: 'auto' }}>→</span>
                    </div>
                  )}
                  {generateTiktok && tiktokLoading && (
                    <div style={{ padding: '7px 12px', background: 'rgba(255,0,80,0.06)', borderTop: '1px solid rgba(255,77,77,0.15)', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, animation: 'spin 1.5s linear infinite', display: 'inline-block' }}>♪</span>
                      <span style={{ fontSize: 10, color: '#4a5568' }}>Generating TikTok ad…</span>
                    </div>
                  )}
                  {/* Headline + CTA bar */}
                  <div style={{ padding: '10px 12px', background: '#f0f2f5', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#1a1a1a' }}>{metaEdits[`hl-${metaActiveVariants.hl}`] !== undefined ? metaEdits[`hl-${metaActiveVariants.hl}`] : (metaResult.headlines?.[metaActiveVariants.hl] || '')}</div>
                      <div style={{ fontSize: 11, color: '#8a8a8a' }}>{(() => { try { return new URL(url).hostname.replace('www.',''); } catch(_) { return url; } })()}</div>
                    </div>
                    <div style={{ background: '#0866ff', color: 'white', fontSize: 11, fontWeight: 700, padding: '6px 12px', borderRadius: 6, whiteSpace: 'nowrap', flexShrink: 0 }}>Learn More</div>
                  </div>
                </div>
                {/* Variant selectors */}
                <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                  {(metaResult.primaryTexts || []).length > 1 && (metaResult.primaryTexts || []).map((_, i) => (
                    <button key={i} onClick={() => setMetaActiveVariants(v => ({...v, pt: i}))} style={{
                      fontSize: 9, padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer',
                      background: metaActiveVariants.pt === i ? 'rgba(14,165,233,0.3)' : 'rgba(255,255,255,0.06)',
                      color: metaActiveVariants.pt === i ? '#38bdf8' : '#4a5568',
                    }}>Text {i+1}</button>
                  ))}
                  {(metaResult.headlines || []).length > 1 && (metaResult.headlines || []).map((_, i) => (
                    <button key={i} onClick={() => setMetaActiveVariants(v => ({...v, hl: i}))} style={{
                      fontSize: 9, padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer',
                      background: metaActiveVariants.hl === i ? 'rgba(99,102,241,0.3)' : 'rgba(255,255,255,0.06)',
                      color: metaActiveVariants.hl === i ? '#a5b4fc' : '#4a5568',
                    }}>HL {i+1}</button>
                  ))}
                </div>
              </div>
            </div>
          <div style={{ fontSize: 9, color: '#2d3748', padding: '4px 2px' }}>⚠️ AI-generated content — always review before publishing. You are responsible for final ad content.</div>
          </>
          )}
          {/* History panel */}
          {history.length > 0 && (
            <div style={S.card}>
              <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button onClick={() => {
                    const allIds = new Set(history.map(h => h.id));
                    const allChecked = history.every(h => selectedForExport.has(h.id));
                    if (allChecked) {
                      setSelectedForExport(new Set());
                    } else {
                      setSelectedForExport(allIds);
                    }
                  }} style={{
                    width: 16, height: 16, borderRadius: 3, border: "none", cursor: "pointer", flexShrink: 0,
                    background: history.every(h => selectedForExport.has(h.id))
                      ? "linear-gradient(135deg,#3b82f6,#6366f1)" : "rgba(255,255,255,0.08)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    {history.every(h => selectedForExport.has(h.id)) &&
                      <span style={{ color: "white", fontSize: 9, fontWeight: 900 }}>✓</span>}
                  </button>
                  <span style={{ ...S.sectionLabel, margin: 0 }}>Recent Generations</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {/* Campaign / Ad Group toggle */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 10, color: omitGroupMulti ? "#8fa3b8" : "#adbccb", fontWeight: 700, letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
                      Campaign / Group
                    </span>
                    <button onClick={() => setOmitGroupMulti(v => !v)} style={{
                      width: 36, height: 20, borderRadius: 10, border: "none", cursor: "pointer", position: "relative",
                      background: omitGroupMulti ? "rgba(255,255,255,0.08)" : "linear-gradient(135deg,#3b82f6,#6366f1)",
                      transition: "background 0.2s", flexShrink: 0,
                    }}>
                      <span style={{
                        position: "absolute", top: 2, left: omitGroupMulti ? 2 : 18,
                        width: 16, height: 16, borderRadius: "50%", background: "white",
                        transition: "left 0.2s", display: "block",
                      }} />
                    </button>
                  </div>
                  <button onClick={() => setShowHistory(!showHistory)} style={{
                    fontSize: 11, fontWeight: 700, color: "#7e92a8",
                    background: "none", border: "none", cursor: "pointer", letterSpacing: "0.04em",
                  }}>{showHistory ? "▲ Hide" : `▼ Show (${history.length})`}</button>
                </div>
              </div>
              {showHistory && (
                <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>

                                    {/* History items with checkboxes — paginated */}
                  {history.slice(historyPage * ADS_PER_PAGE, (historyPage + 1) * ADS_PER_PAGE).map((h, i) => {
                    const isSelected = selectedForExport.has(h.id);
                    const isMeta = !!h.metaResult; // has Meta ad stored
                    const isGoogleOnly = !h.metaResult;  // RSA/PMax with no Meta result
                    // Meta entries: distinct styling, CSV-only button, excluded from Google export checkbox
                    return (() => {
                      const inactive = adFormat === "meta" && !isMeta; // only dim on Meta tab if no Meta result
                      return (
                      <div key={h.id} style={{
                        padding: "10px 12px", borderRadius: 8,
                        background: isMeta
                          ? "rgba(14,165,233,0.05)"
                          : isSelected ? "rgba(99,102,241,0.08)" : "rgba(255,255,255,0.03)",
                        border: `1px solid ${isMeta ? "rgba(14,165,233,0.2)" : isSelected ? "rgba(99,102,241,0.3)" : "rgba(255,255,255,0.07)"}`,
                        display: "flex", alignItems: "center", gap: 10,
                        transition: "all 0.2s",
                        opacity: inactive ? 0.35 : 1,
                        pointerEvents: inactive ? "none" : "auto",
                      }}>
                        {/* Checkbox — RSA/PMax entries for Google export; Meta entries selectable on Meta tab */}
                        {isMeta ? (
                          <button onClick={() => {
                            if (adFormat !== "meta") return; // only active on Meta tab
                            setSelectedForExport(prev => {
                              const next = new Set(prev);
                              next.has(h.id) ? next.delete(h.id) : next.add(h.id);
                              return next;
                            });
                            setRows(h.rows);
                            setActiveRow(0);
                            setUrl(h.url);
                            setGenerated(true);
                            if (h.metaResult) { 
                              setMetaResult(h.metaResult); 
                              setMetaError('');
                              // If no images stored, refetch them
                              if (!h.metaResult.imageUrl && !h.metaResult.imageVariations?.length && h.metaResult.imagePrompts) {
                                setMetaImagesLoading(true);
                                metaGenId.current += 1;
                                const thisGenId = metaGenId.current;
                                const genImg = async (prompt) => {
                                  if (!prompt) return null;
                                  try {
                                    const r = await fetch('/api/imagen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
                                    const d = await r.json();
                                    return d.imageUrl || null;
                                  } catch(_) { return null; }
                                };
                                const { s1, v1, v2 } = h.metaResult.imagePrompts;
                                Promise.all([genImg(s1), genImg(v1), genImg(v2 || null)]).then(([is1, iv1, iv2]) => {
                                  if (metaGenId.current !== thisGenId) return;
                                  setMetaImagesLoading(false);
                                  const variations = [h.metaResult.heroProductImage, h.metaResult.secondaryImage, is1, iv1, iv2].filter(Boolean);
                                  if (variations.length > 0) setMetaResult(prev => prev ? ({ ...prev, imageUrl: variations[0], imageVariations: variations }) : prev);
                                });
                              }
                            }
                          }} style={{
                            cursor: adFormat === "meta" ? "pointer" : "default",
                            background: isSelected && adFormat === "meta"
                              ? "linear-gradient(135deg,#0ea5e9,#6366f1)"
                              : "rgba(255,255,255,0.08)",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            transition: "background 0.15s",
                          }}>
                            {isSelected && adFormat === "meta" && <span style={{ color: "white", fontSize: 10, fontWeight: 900 }}>✓</span>}
                          </button>
                        ) : (
                          <button onClick={() => {
                            setSelectedForExport(prev => {
                              const next = new Set(prev);
                              next.has(h.id) ? next.delete(h.id) : next.add(h.id);
                              return next;
                            });
                            setRows(h.rows);
                            setActiveRow(0);
                            setUrl(h.url);
                            setGenerated(true);
                            if (h.format) setAdFormat(h.format);
                            if (h.metaResult) {
                              setMetaResult(h.metaResult);
                              setMetaError("");
                            } else {
                              setMetaResult(null);
                              setGenerateMeta(false);
                            }
                          }} style={{
                            width: 18, height: 18, borderRadius: 4, border: "none", cursor: "pointer", flexShrink: 0,
                            background: isSelected ? "linear-gradient(135deg,#6366f1,#8b5cf6)" : "rgba(255,255,255,0.08)",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            transition: "background 0.15s",
                          }}>
                            {isSelected && <span style={{ color: "white", fontSize: 10, fontWeight: 900 }}>✓</span>}
                          </button>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#e2e8f0", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center" }}>
                            {h.rows[0]?.campaign || (() => { try { return new URL(h.url).hostname; } catch { return h.url; } })()}
                            {h.metaResult && (
                              <span style={{
                                marginLeft: 5, fontSize: 8, fontWeight: 700,
                                color: "#0ea5e9", background: "rgba(14,165,233,0.1)",
                                border: "1px solid rgba(14,165,233,0.2)",
                                borderRadius: 3, padding: "1px 4px", flexShrink: 0,
                              }}>◉ META</span>
                            )}
                          </div>
                          <div style={{ fontSize: 10, color: "#8fa3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {h.url}
                          </div>
                          <div style={{ fontSize: 9, color: "#8fa3b8", marginTop: 2 }}>
                            {h.timestamp}
                            {h.format === "pmax"
                              ? <span style={{ marginLeft: 6, padding: "1px 5px", background: "rgba(99,102,241,0.15)", borderRadius: 3, color: "#a5b4fc" }}>PMax</span>
                              : <span style={{ marginLeft: 6, padding: "1px 5px", background: "rgba(59,130,246,0.15)", borderRadius: 3, color: "#93c5fd" }}>RSA</span>
                            }
                            {h.format !== "pmax" && h.rows[0]?.headlines?.[0]?.text && (
                              <span style={{ marginLeft: 4 }}>· {h.rows[0].headlines[0].text.slice(0, 28)}{h.rows[0].headlines[0].text.length > 28 ? "…" : ""}</span>
                            )}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 5, flexShrink: 0, alignItems: "center" }}>
                          {/* Meta CSV button — only on entries with metaResult */}
                          {h.metaResult && (
                            <button onClick={() => {
                                                            const r = h.metaResult;
                              const dataRows = (r.primaryTexts || []).map((pt, i) => [
                                "", h.rows[0]?.campaign || "RSA Studio Campaign", "ACTIVE", "Traffic", "AUCTION",
                                "", "", "", "Yes",
                                "", "", "", "", "",
                                "ACTIVE", "", (h.rows[0]?.campaign || "RSA Studio") + " - Ad Set",
                                "", "", "", "", "", "",
                                h.url, (() => { try { return new URL(h.url).hostname.replace("www.",""); } catch(_){return "";} })(),
                                "", "", "", "", "", "", "", "", "",
                                "LANDING_PAGE_VIEWS", "", "IMPRESSIONS",
                                "", "", "",
                                "ACTIVE", "", "",
                                `Meta Ad ${i + 1} — ${h.rows[0]?.campaign || h.url}`, pt, r.headlines?.[i] || r.headlines?.[0] || "",
                                "", "", "Page Post Ad",
                                "", "", "", "LEARN_MORE",
                                "", "", "", "",
                              ]);
                              const csv = "Campaign ID	Campaign Name	Campaign Status	Campaign Objective	Buying Type	Campaign Daily Budget	Campaign Bid Strategy	Campaign Start Time	New Objective	Buy With Prime Type	Is Budget Scheduling Enabled For Campaign	Campaign High Demand Periods	Buy With Integration Partner	Ad Set ID	Ad Set Run Status	Ad Set Lifetime Impressions	Ad Set Name	Ad Set Time Start	Destination Type	Use Accelerated Delivery	Is Budget Scheduling Enabled For Ad Set	Ad Set High Demand Periods	Link Object ID	Link	Display Link	Countries	Location Types	Age Min	Age Max	Excluded Custom Audiences	Advantage Audience	Age Range	Targeting Optimization	Brand Safety Inventory Filtering Levels	Optimization Goal	Attribution Spec	Billing Event	Regional Regulated Categories	Story ID	Ad ID	Ad Status	Preview Link	Instagram Preview Link	Ad Name	Body	Title	Optimize text per person	Optimized Ad Creative	Creative Type	URL Tags	Video ID	Instagram Account ID	Call to Action	Additional Custom Tracking Specs	Video Retargeting	Permalink	Use Page as Actor\n" + dataRows.map(row => row.map(v => String(v).replace(/\t/g, " ").replace(/\n/g, " ")).join("\t")).join("\n");
                              const blob = new Blob([csv], { type: "text/plain" });
                              const a = document.createElement("a");
                              a.href = URL.createObjectURL(blob);
                              a.download = "meta-ads-export.txt";
                              a.click();
                            }} style={{
                              padding: "4px 8px", fontSize: 10, fontWeight: 700,
                              background: "rgba(14,165,233,0.12)", color: "#38bdf8",
                              border: "1px solid rgba(14,165,233,0.25)", borderRadius: 5, cursor: "pointer",
                            }}>◉ CSV</button>
                          )}
                          <button onClick={() => {
                            setRows(h.rows);
                            setActiveRow(0);
                            setUrl(h.url);
                            setGenerated(true);
                            setShowHistory(false);
                            if (h.format) setAdFormat(h.format);
                            if (h.metaResult) {
                              setMetaResult(h.metaResult);
                              setMetaError("");
                            }
                          }} style={{
                            padding: "5px 10px", fontSize: 11, fontWeight: 700,
                            background: "rgba(59,130,246,0.15)", color: "#60a5fa",
                            border: "1px solid rgba(59,130,246,0.25)", borderRadius: 6, cursor: "pointer",
                          }}>Load</button>
                          {isSignedIn && (
                            <button onClick={async () => {
                              const alreadySaved = library.some(e => e.id === h.id);
                              if (alreadySaved) {
                                await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', userId: user.id, entryId: h.id }) });
                                setLibrary(prev => prev.filter(e => e.id !== h.id));
                              } else {
                                setLibrarySaving(h.id);
                                const r = await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save', userId: user.id, entry: h, plan }) });
                                const d = await r.json();
                                if (d.ok) setLibrary(prev => [{ ...h, savedAt: new Date().toISOString() }, ...prev]);
                                else if (d.limitReached) alert('Library limit reached. Remove some saved outputs first.');
                                setLibrarySaving(null);
                              }
                            }} style={{
                              padding: '5px 8px', fontSize: 13, fontWeight: 700,
                              background: library.some(e => e.id === h.id) ? 'rgba(245,158,11,0.2)' : 'rgba(255,255,255,0.05)',
                              color: library.some(e => e.id === h.id) ? '#fbbf24' : '#4a5568',
                              border: '1px solid ' + (library.some(e => e.id === h.id) ? 'rgba(245,158,11,0.3)' : 'rgba(255,255,255,0.08)'),
                              borderRadius: 6, cursor: 'pointer', transition: 'all 0.2s',
                            }}>{librarySaving === h.id ? '...' : library.some(e => e.id === h.id) ? '★' : '☆'}</button>
                          )}
                        </div>
                      </div>
                      );
                    })()
                  })}

                  <Paginator page={historyPage} total={history.length} perPage={ADS_PER_PAGE} onChange={p => setHistoryPage(p)} />

                  {/* Multi-export tray — Google RSA/PMax only, Meta entries excluded */}
                  {selectedForExport.size > 0 && (() => {
                    // Meta tab: build Meta CSV from current ad only; Google tabs: build Google TSV
                    const isMetaTab = adFormat === "meta";
                    const googleSelected = history.filter(h => selectedForExport.has(h.id) && !h.metaResult);
                    const metaSelectedCount = metaResult ? 1 : 0;
                    const totalSelected = isMetaTab ? metaSelectedCount : googleSelected.length;
                    // Current Meta ad only (not all history)
                    const metaCsvRows = metaResult ? (metaResult.primaryTexts || []).map((pt, i) => [
                      "", row?.campaign || "RSA Studio Campaign", "ACTIVE", "Traffic", "AUCTION",
                      "", "", "", "Yes", "", "", "", "",
                      "", "ACTIVE", "", (row?.campaign || "RSA Studio") + " - Ad Set",
                      "", "", "", "", "", "",
                      url, (() => { try { return new URL(url).hostname.replace("www.",""); } catch(_){return "";} })(),
                      "", "", "", "", "", "", "", "", "",
                      "LANDING_PAGE_VIEWS", "", "IMPRESSIONS",
                      "", "", "",
                      "ACTIVE", "", "",
                      `Meta Ad ${i + 1}`, pt, metaResult.headlines?.[i] || metaResult.headlines?.[0] || "",
                      "", "", "Page Post Ad",
                      "", "", "", "LEARN_MORE",
                      "", "", "", "",
                    ]) : [];
                    const metaCsvStr = "Campaign ID\tCampaign Name\tCampaign Status\tCampaign Objective\tBuying Type\tCampaign Daily Budget\tCampaign Bid Strategy\tCampaign Start Time\tNew Objective\tBuy With Prime Type\tIs Budget Scheduling Enabled For Campaign\tCampaign High Demand Periods\tBuy With Integration Partner\tAd Set ID\tAd Set Run Status\tAd Set Lifetime Impressions\tAd Set Name\tAd Set Time Start\tDestination Type\tUse Accelerated Delivery\tIs Budget Scheduling Enabled For Ad Set\tAd Set High Demand Periods\tLink Object ID\tLink\tDisplay Link\tCountries\tLocation Types\tAge Min\tAge Max\tExcluded Custom Audiences\tAdvantage Audience\tAge Range\tTargeting Optimization\tBrand Safety Inventory Filtering Levels\tOptimization Goal\tAttribution Spec\tBilling Event\tRegional Regulated Categories\tStory ID\tAd ID\tAd Status\tPreview Link\tInstagram Preview Link\tAd Name\tBody\tTitle\tOptimize text per person\tOptimized Ad Creative\tCreative Type\tURL Tags\tVideo ID\tInstagram Account ID\tCall to Action\tAdditional Custom Tracking Specs\tVideo Retargeting\tPermalink\tUse Page as Actor\n" + metaCsvRows.map(r => r.map(v => String(v).replace(/\t/g," ").replace(/\n/g," ")).join("\t")).join("\n");


                    const handleMultiCopy = async () => {
                      const payload = isMetaTab ? metaCsvStr : multiTsv;
                      try {
                        await navigator.clipboard.writeText(payload);
                      } catch (_) {
                        const ta = document.createElement("textarea");
                        ta.value = payload;
                        ta.style.cssText = "position:fixed;top:-9999px;opacity:0";
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand("copy");
                        document.body.removeChild(ta);
                      }
                      setMultiCopied(true);
                      setTimeout(() => setMultiCopied(false), 2500);
                    };

                    const handleMultiDownload = () => {
                      if (adFormat === "meta") {
                        // Export current Meta ad only
                        if (!metaResult) return;
                        const dataRows = (metaResult.primaryTexts || []).map((pt, i) => [
                          "", row?.campaign || "RSA Studio Campaign", "ACTIVE", "Traffic", "AUCTION",
                          "", "", "", "Yes", "", "", "", "",
                          "", "ACTIVE", "", (row?.campaign || "RSA Studio") + " - Ad Set",
                          "", "", "", "", "", "",
                          url, (() => { try { return new URL(url).hostname.replace("www.",""); } catch(_){return "";} })(),
                          "", "", "", "", "", "", "", "", "",
                          "LANDING_PAGE_VIEWS", "", "IMPRESSIONS",
                          "", "", "",
                          "ACTIVE", "", "",
                          `Meta Ad ${i + 1}`, pt, metaResult.headlines?.[i] || metaResult.headlines?.[0] || "",
                          "", "", "Page Post Ad",
                          "", "", "", "LEARN_MORE",
                          "", "", "", "",
                        ]);
                        const tsv = "Campaign ID\tCampaign Name\tCampaign Status\tCampaign Objective\tBuying Type\tCampaign Daily Budget\tCampaign Bid Strategy\tCampaign Start Time\tNew Objective\tBuy With Prime Type\tIs Budget Scheduling Enabled For Campaign\tCampaign High Demand Periods\tBuy With Integration Partner\tAd Set ID\tAd Set Run Status\tAd Set Lifetime Impressions\tAd Set Name\tAd Set Time Start\tDestination Type\tUse Accelerated Delivery\tIs Budget Scheduling Enabled For Ad Set\tAd Set High Demand Periods\tLink Object ID\tLink\tDisplay Link\tCountries\tLocation Types\tAge Min\tAge Max\tExcluded Custom Audiences\tAdvantage Audience\tAge Range\tTargeting Optimization\tBrand Safety Inventory Filtering Levels\tOptimization Goal\tAttribution Spec\tBilling Event\tRegional Regulated Categories\tStory ID\tAd ID\tAd Status\tPreview Link\tInstagram Preview Link\tAd Name\tBody\tTitle\tOptimize text per person\tOptimized Ad Creative\tCreative Type\tURL Tags\tVideo ID\tInstagram Account ID\tCall to Action\tAdditional Custom Tracking Specs\tVideo Retargeting\tPermalink\tUse Page as Actor\n" + dataRows.map(r => r.map(v => String(v).replace(/\t/g," ").replace(/\n/g," ")).join("\t")).join("\n");

                        const a = document.createElement("a");
                        a.href = "data:text/plain;charset=utf-8," + encodeURIComponent(tsv);
                        a.download = "meta-ads-export.txt";
                        document.body.appendChild(a); a.click(); document.body.removeChild(a);
                      } else {
                        const encoded = "data:text/tab-separated-values;charset=utf-8," + encodeURIComponent(multiTsv);
                        const a = document.createElement("a");
                        a.href = encoded;
                        a.download = `rsa_ads_${totalSelected}_variants.tsv`;
                        document.body.appendChild(a); a.click(); document.body.removeChild(a);
                      }
                    };

                    return (
                      <div style={{
                        marginTop: 4, padding: "12px 14px",
                        background: "linear-gradient(135deg,rgba(99,102,241,0.12),rgba(59,130,246,0.08))",
                        border: "1px solid rgba(99,102,241,0.3)", borderRadius: 10,
                      }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#a5b4fc", marginBottom: 10 }}>
                          ✦ {totalSelected} ad version{totalSelected > 1 ? "s" : ""} selected for export
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button onClick={handleMultiCopy} style={{
                            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                            padding: "9px 16px", fontSize: 12, fontWeight: 700, borderRadius: 7,
                            cursor: "pointer", transition: "all 0.3s", flex: 1,
                            background: adFormat === "meta"
                              ? "linear-gradient(135deg,rgba(14,165,233,0.25),rgba(99,102,241,0.25))"
                              : "linear-gradient(135deg,rgba(99,102,241,0.25),rgba(139,92,246,0.25))",
                            color: adFormat === "meta" ? "#38bdf8" : "#a5b4fc",
                            border: adFormat === "meta"
                              ? "1px solid rgba(14,165,233,0.4)"
                              : "1px solid rgba(99,102,241,0.4)",
                          }}>
                            {multiCopied ? "Copied!" : adFormat === "meta" ? "Copy for Meta Ads" : "Copy all to Editor"}
                          </button>
                          {adFormat !== "meta" && (
                          <button onClick={handleMultiDownload} style={{
                            padding: "9px 12px", fontSize: 12, fontWeight: 700,
                            background: "rgba(255,255,255,0.06)", color: "#8fa3b8",
                            border: "1px solid rgba(255,255,255,0.1)", borderRadius: 7, cursor: "pointer",
                            display: "flex", alignItems: "center", gap: 5,
                          }}>
                            ⬇ CSV
                          </button>
                          )}
                        </div>
                        <div style={{ fontSize: 10, color: "#8fa3b8", marginTop: 8 }}>
                          {adFormat === "meta" ? `All ${totalSelected} Meta ad variants ready — paste into Meta Ads Manager` : `All ${totalSelected} versions exported as separate rows — paste directly into Google Ads Editor`}
                        </div>
                      </div>
                    );
                  })()}

                </div>
              )}
            </div>
          )}

          {/* Meta Preview — shown in left panel when Meta tab active */}
          {adFormat === "meta" && (<>
            <div style={S.card}>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ ...S.sectionLabel, margin: 0 }}>Meta Ad Preview</span>
                {metaResult && (
                  <div style={{ display: "flex", gap: 4 }}>
                    {[
                      { id: "fb-feed",  label: "FB Feed",  icon: "▣" },
                      { id: "ig-feed",  label: "IG Feed",  icon: "◎" },
                      { id: "ig-story", label: "IG Story", icon: "▯" },
                      { id: "fb-story", label: "FB Story", icon: "▮" },
                    ].map(f => (
                      <button key={f.id} onClick={() => setMetaPreviewFormat(f.id)} style={{
                        padding: "3px 7px", borderRadius: 5, border: "none", cursor: "pointer", fontSize: 9, fontWeight: 700,
                        background: metaPreviewFormat === f.id ? "rgba(99,102,241,0.2)" : "rgba(255,255,255,0.04)",
                        color: metaPreviewFormat === f.id ? "#a5b4fc" : "#4a5568",
                        transition: "all 0.15s",
                      }}>{f.icon} {f.label}</button>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ padding: "16px" }}>
                {metaLoading && (
                  <div style={{ textAlign: "center", padding: "32px 0" }}>
                    <div style={{ fontSize: 28, animation: "spin 1.5s linear infinite", display: "inline-block", marginBottom: 10 }}>◉</div>
                    <div style={{ fontSize: 12, color: "#4a5568" }}>Generating Meta ads…</div>
                  </div>
                )}
                {!metaLoading && !metaResult && (
                  <div style={{ textAlign: "center", padding: "32px 16px" }}>
                    <div style={{ fontSize: 28, marginBottom: 10, opacity: 0.3 }}>◉</div>
                    {metaError ? (
                      <div style={{ fontSize: 11, color: "#f87171", lineHeight: 1.5, marginBottom: 8 }}>{metaError}</div>
                    ) : (
                      <div style={{ fontSize: 11, color: "#4a5568", lineHeight: 1.5 }}>
                        Check "Also generate Meta ads" below the URL bar and click Generate
                      </div>
                    )}
                  </div>
                )}
                {!metaLoading && metaResult && (() => {
                  const brand = row.campaign || (() => { try { return new URL(url).hostname.replace("www.", ""); } catch { return "Your Brand"; } })();
                  const domain = (() => { try { return new URL(url).hostname.replace("www.", ""); } catch { return ""; } })();
                  const pt  = metaEdits[`pt-${metaActiveVariants.pt}`] !== undefined ? metaEdits[`pt-${metaActiveVariants.pt}`] : (metaResult.primaryTexts?.[metaActiveVariants.pt] || "");
                  const hl  = metaEdits[`hl-${metaActiveVariants.hl}`] !== undefined ? metaEdits[`hl-${metaActiveVariants.hl}`] : (metaResult.headlines?.[metaActiveVariants.hl] || "");
                  const d   = metaEdits[`desc-${metaActiveVariants.d}`] !== undefined ? metaEdits[`desc-${metaActiveVariants.d}`] : (metaResult.descriptions?.[metaActiveVariants.d] || "");
                  const img = metaResult.imageUrl;
                  const isStory = metaPreviewFormat === "ig-story" || metaPreviewFormat === "fb-story";
                  const isIG    = metaPreviewFormat === "ig-feed"  || metaPreviewFormat === "ig-story";
                  return (
                    <div style={{ display: "flex", justifyContent: "center" }}>
                      {isStory ? (
                        <div style={{ width: 200, height: 356, borderRadius: 14, overflow: "hidden", position: "relative", background: img ? "transparent" : "linear-gradient(160deg,#1e293b,#0f172a)", boxShadow: "0 4px 24px rgba(0,0,0,0.5)", flexShrink: 0 }}>
                          {img && <img src={img} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />}
                          <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, rgba(0,0,0,0.35) 0%, transparent 35%, transparent 55%, rgba(0,0,0,0.7) 100%)" }} />
                          <div style={{ position: "absolute", top: 10, left: 10, right: 10 }}>
                            <div style={{ height: 2, background: "rgba(255,255,255,0.3)", borderRadius: 1, marginBottom: 8 }}>
                              <div style={{ width: "60%", height: "100%", background: "white", borderRadius: 1 }} />
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <div style={{ width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
                                background: isIG ? "linear-gradient(135deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)" : "linear-gradient(135deg,#1877f2,#0ea5e9)",
                                padding: 2, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                                {pmaxLogo
                                  ? <img src={pmaxLogo} alt="" style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: "50%", border: "1.5px solid white" }} onError={e => { e.target.style.display="none"; }} />
                                  : <div style={{ width: "100%", height: "100%", borderRadius: "50%", background: "rgba(255,255,255,0.3)", display:"flex", alignItems:"center", justifyContent:"center", fontSize: 8, fontWeight:700, color:"white" }}>{brand?.[0]?.toUpperCase()}</div>
                                }
                              </div>
                              <span style={{ fontSize: 9, fontWeight: 700, color: "white" }}>{brand}</span>
                            </div>
                          </div>
                          <div style={{ position: "absolute", bottom: 44, left: 10, right: 10 }}>
                            <div style={{ fontSize: 10, color: "white", fontWeight: 700, marginBottom: 3, lineHeight: 1.3 }}>{hl}</div>
                            <div style={{ fontSize: 8, color: "rgba(255,255,255,0.85)", lineHeight: 1.4 }}>{pt.slice(0, 80)}{pt.length > 80 ? "…" : ""}</div>
                          </div>
                          <div style={{ position: "absolute", bottom: 10, left: "50%", transform: "translateX(-50%)" }}>
                            <div style={{ background: "white", borderRadius: 20, padding: "4px 14px", fontSize: 9, fontWeight: 800, color: "#050505", whiteSpace: "nowrap" }}>Learn More ↑</div>
                          </div>
                        </div>
                      ) : (
                        <div style={{ width: 260, background: "white", borderRadius: 10, overflow: "hidden", boxShadow: "0 2px 16px rgba(0,0,0,0.45)", flexShrink: 0 }}>
                          <div style={{ padding: "8px 10px", display: "flex", alignItems: "center", gap: 7 }}>
                            <div style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0, background: isIG ? "linear-gradient(135deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)" : "linear-gradient(135deg,#0ea5e9,#6366f1)", padding: isIG ? 2 : 0, boxSizing: "border-box" }}>
                              {pmaxLogo
                                ? <img src={pmaxLogo} alt="" style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: "50%", border: isIG ? "2px solid white" : "none" }} onError={e => { e.target.style.display="none"; }} />
                                : <div style={{ width: "100%", height: "100%", borderRadius: "50%", background: "linear-gradient(135deg,#0ea5e9,#6366f1)", border: isIG ? "2px solid white" : "none", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, color:"white" }}>{brand?.[0]?.toUpperCase()}</div>
                              }
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: 10, fontWeight: 700, color: "#1c1e21" }}>{brand}</div>
                              <div style={{ fontSize: 8, color: isIG ? "#8e8e8e" : "#65676b" }}>{isIG ? "Sponsored" : "Sponsored · 🌐"}</div>
                            </div>
                            <div style={{ fontSize: 14, color: "#65676b" }}>···</div>
                          </div>
                          {(!isIG && pt) ? <div style={{ padding: "6px 10px", fontSize: 11, color: "#1c1e21", lineHeight: 1.5 }}>{pt.slice(0, 125)}{pt.length > 125 ? "…" : ""}</div>
                          : null}
                          <div style={{ aspectRatio: "1/1", background: "#f0f0f0", overflow: "hidden" }}>
                            {img ? <img src={img} alt="Ad" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                              : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg,rgba(99,102,241,0.1),rgba(14,165,233,0.1))" }}><span style={{ fontSize: 22, opacity: 0.2 }}>◉</span></div>
                              }
                          </div>
                          {isIG && (
                            <div style={{ padding: "6px 10px 4px" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                                <div style={{ fontSize: 16 }}>♡ △ ✈</div><div style={{ fontSize: 16 }}>⊠</div>
                              </div>
                              <div style={{ fontSize: 9, color: "#262626", lineHeight: 1.4 }}><span style={{ fontWeight: 700 }}>{brand}</span> {pt.slice(0, 90)}{pt.length > 90 ? "…" : ""}</div>
                            </div>
                          )}
                          {!isIG && (
                            <div style={{ padding: "7px 10px", background: "#f0f2f5", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 8, color: "#65676b", textTransform: "uppercase", marginBottom: 1 }}>{domain}</div>
                                <div style={{ fontSize: 10, fontWeight: 700, color: "#1c1e21", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hl}</div>
                                <div style={{ fontSize: 9, color: "#65676b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d}</div>
                              </div>
                              <button style={{ padding: "4px 8px", background: "#e4e6eb", border: "none", borderRadius: 4, fontSize: 9, fontWeight: 700, color: "#050505", cursor: "pointer", flexShrink: 0 }}>Learn More</button>
                            </div>
                          )}
                          {isIG ? <div style={{ padding: "5px 10px 8px", display: "flex", justifyContent: "space-between" }}><div style={{ fontSize: 9, color: "#262626" }}><span style={{ fontWeight: 700 }}>Learn more</span> · {domain}</div><div style={{ fontSize: 9, color: "#0095f6", fontWeight: 700 }}>Shop Now</div></div>
                          : null}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>
          </>)}

          {/* Export + Guide */}
          <div style={S.card}>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ ...S.sectionLabel, margin: 0 }}>{adFormat === "meta" ? "Export for Meta Ads" : "Export to Google Ads Editor"}</span>
              <button onClick={() => setShowGuide(!showGuide)} style={{
                fontSize: 11, fontWeight: 700, color: "#7e92a8",
                background: "none", border: "none", cursor: "pointer", letterSpacing: "0.04em",
              }}>{showGuide ? "▲ Hide guide" : "▼ Show import guide"}</button>
            </div>

            <div style={{ padding: "14px 18px" }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
                {adFormat !== "meta" && (
                  <div style={{ flex: 1, minWidth: 160, display: "flex", flexDirection: "column", gap: 6 }}>
                    <button onClick={copyTSV} style={{
                      width: "100%", padding: "11px 16px", fontSize: 13, fontWeight: 700,
                      background: copied ? "linear-gradient(135deg,#059669,#10b981)" : "linear-gradient(135deg,#3b82f6,#6366f1)",
                      color: "white", border: "none", borderRadius: 8, cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                      transition: "all 0.3s", boxShadow: copied ? "0 0 20px rgba(16,185,129,0.3)" : "0 0 14px rgba(99,102,241,0.3)",
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
                )}
                {adFormat === "meta" && (
                  <div style={{ flex: 1, minWidth: 160, display: "flex", flexDirection: "column", gap: 6 }}>
                    <button onClick={async () => {
                      const r = metaResult || {};
                      const dataRows = (r.primaryTexts || []).map((pt, i) => [
                        "", row?.campaign || "RSA Studio Campaign", "ACTIVE", "Traffic", "AUCTION",
                        "", "", "", "Yes", "", "", "", "",
                        "", "ACTIVE", "", (row?.campaign || "RSA Studio") + " - Ad Set",
                        "", "", "", "", "", "",
                        url, (() => { try { return new URL(url).hostname.replace("www.",""); } catch(_){return "";} })(),
                        "", "", "", "", "", "", "", "", "",
                        "LANDING_PAGE_VIEWS", "", "IMPRESSIONS",
                        "", "", "",
                        "ACTIVE", "", "",
                        "Meta Ad " + (i + 1), pt, r.headlines?.[i] || r.headlines?.[0] || "",
                        "", "", "Page Post Ad",
                        "", "", "", "LEARN_MORE",
                        "", "", "", "",
                      ]);
                      const payload = "Campaign ID	Campaign Name	Campaign Status	Campaign Objective	Buying Type	Campaign Daily Budget	Campaign Bid Strategy	Campaign Start Time	New Objective	Buy With Prime Type	Is Budget Scheduling Enabled For Campaign	Campaign High Demand Periods	Buy With Integration Partner	Ad Set ID	Ad Set Run Status	Ad Set Lifetime Impressions	Ad Set Name	Ad Set Time Start	Destination Type	Use Accelerated Delivery	Is Budget Scheduling Enabled For Ad Set	Ad Set High Demand Periods	Link Object ID	Link	Display Link	Countries	Location Types	Age Min	Age Max	Excluded Custom Audiences	Advantage Audience	Age Range	Targeting Optimization	Brand Safety Inventory Filtering Levels	Optimization Goal	Attribution Spec	Billing Event	Regional Regulated Categories	Story ID	Ad ID	Ad Status	Preview Link	Instagram Preview Link	Ad Name	Body	Title	Optimize text per person	Optimized Ad Creative	Creative Type	URL Tags	Video ID	Instagram Account ID	Call to Action	Additional Custom Tracking Specs	Video Retargeting	Permalink	Use Page as Actor\n" + dataRows.map(r => r.map(v => String(v).replace(/\t/g," ").replace(/\n/g," ")).join("\t")).join("\n");
                      try { await navigator.clipboard.writeText(payload); } catch(_) {
                        const ta = document.createElement("textarea"); ta.value = payload;
                        ta.style.cssText = "position:fixed;top:-9999px;opacity:0";
                        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
                      }
                      setMultiCopied(true); setTimeout(() => setMultiCopied(false), 2500);
                    }} style={{
                      width: "100%", padding: "11px 16px", fontSize: 13, fontWeight: 700,
                      background: multiCopied ? "linear-gradient(135deg,#0369a1,#0ea5e9)" : "linear-gradient(135deg,rgba(14,165,233,0.3),rgba(99,102,241,0.3))",
                      color: multiCopied ? "white" : "#38bdf8",
                      border: "1px solid rgba(14,165,233,0.4)", borderRadius: 8, cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                      transition: "all 0.3s",
                    }}>
                      <span style={{ fontSize: 16 }}>{multiCopied ? "✓" : "📋"}</span>
                      {multiCopied ? "Copied to clipboard!" : "Copy for Meta Ads"}
                    </button>
                  </div>
                )}
                <button onClick={downloadCSV} style={{
                  padding: "11px 16px", fontSize: 13, fontWeight: 700,
                  background: "rgba(255,255,255,0.05)", color: "#8fa3b8",
                  border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 6,
                }}>
                  ⬇ Download CSV
                </button>
              </div>

              <ScoreWidget outputId={'rsa-' + rows[activeRow]?.id} format="rsa" label="Rate this RSA copy" />
              {/* TSV mini-preview */}
              <div style={{ background: "rgba(0,0,0,0.3)", borderRadius: 7, padding: "10px 12px", overflowX: "auto" }}>
                <div style={{ fontSize: 9, color: "#8fa3b8", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>TSV preview — {rows.length} ad{rows.length > 1 ? "s" : ""}</div>
                <table style={{ borderCollapse: "collapse", fontSize: 10, fontFamily: "monospace", color: "#8fa3b8", whiteSpace: "nowrap" }}>
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
                  <div style={{ fontSize: 10, fontWeight: 800, color: "#8fa3b8", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 10 }}>Step-by-step import</div>
                  {(IMPORT_STEPS[adFormat] || IMPORT_STEPS.rsa).map(s => (
                    <div key={s.n} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 7 }}>
                      <span style={{
                        fontSize: 10, fontWeight: 800, fontFamily: "monospace",
                        color: "#3b82f6", background: "rgba(59,130,246,0.1)",
                        border: "1px solid rgba(59,130,246,0.2)",
                        borderRadius: 4, padding: "2px 5px", flexShrink: 0, marginTop: 1,
                      }}>{s.n}</span>
                      <span style={{ fontSize: 12, color: "#8fa3b8", lineHeight: 1.45 }}>{s.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          </div>
          )} {/* end RSA/PMax conditional */}

          {/* ── Meta Ad Suite Tab ────────────────────────────────────────────── */}
          {adFormat === "meta" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

              {/* Loading state */}
              {metaLoading && (
                <div style={{ ...S.card, padding: "32px 24px", textAlign: "center" }}>
                  <div style={{ fontSize: 28, marginBottom: 12, animation: "spin 1.5s linear infinite", display: "inline-block" }}>◉</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#e2e8f0", marginBottom: 4 }}>Generating Meta ads…</div>
                  <div style={{ fontSize: 11, color: "#4a5568" }}>Adapting copy for Facebook & Instagram</div>
                </div>
              )}

              {/* Empty state — not yet generated */}
              {!metaLoading && !metaResult && (
                <div style={{ ...S.card, padding: "40px 24px", textAlign: "center" }}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>◉</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0", marginBottom: 8 }}>Meta Ad Suite</div>
                  <div style={{ fontSize: 12, color: "#4a5568", maxWidth: 280, margin: "0 auto 20px" }}>
                    Check "Also generate Meta ads" below the URL bar, then click Generate to create Facebook & Instagram ad copy alongside your Google ads.
                  </div>
                  <button onClick={() => { setGenerateMeta(true); setAdFormat("rsa"); }} style={{
                    padding: "9px 20px", borderRadius: 8, border: "none", cursor: "pointer",
                    background: "linear-gradient(135deg,#0ea5e9,#6366f1)", color: "white",
                    fontWeight: 700, fontSize: 12,
                  }}>← Go back and enable Meta generation</button>
                </div>
              )}

              {/* Meta results */}
              {!metaLoading && metaResult && (() => {
                const copyField = async (text, key) => {
                  try { await navigator.clipboard.writeText(text); }
                  catch {
                    const ta = document.createElement("textarea");
                    ta.value = text; ta.style.cssText = "position:fixed;top:-9999px;opacity:0";
                    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
                  }
                  setMetaCopied(prev => ({ ...prev, [key]: true }));
                  setTimeout(() => setMetaCopied(prev => ({ ...prev, [key]: false })), 2000);
                };

                return (
                  <>
                    {/* Primary Text variants */}
                    <div style={S.card}>
                      <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                        <span style={S.sectionLabel}>Primary Text</span>
                        <span style={{ fontSize: 10, color: "#4a5568", marginLeft: 8 }}>125 chars · hook-led · 3 variants</span>
                      </div>
                      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
                        {(metaResult.primaryTexts || []).map((text, i) => {
                          const key = `pt-${i}`;
                          const val = metaEdits[key] !== undefined ? metaEdits[key] : text;
                          const isActive = metaActiveVariants.pt === i;
                          const isEditing = metaEditingField === key;
                          return (
                            <div key={i} onClick={() => !isEditing && setMetaActiveVariants(v => ({ ...v, pt: i }))} style={{
                              padding: "10px 12px", borderRadius: 8, cursor: isEditing ? 'default' : "pointer",
                              background: isActive ? "rgba(99,102,241,0.08)" : "rgba(255,255,255,0.02)",
                              border: "1px solid " + (isActive ? "rgba(99,102,241,0.3)" : "rgba(255,255,255,0.06)"),
                              display: "flex", alignItems: "flex-start", gap: 10, transition: "all 0.15s",
                            }}>
                              <span style={{ fontSize: 9, fontWeight: 800, color: isActive ? "#818cf8" : "#2d3748", flexShrink: 0, marginTop: 2 }}>PT{i+1}</span>
                              {isEditing ? (
                                <textarea autoFocus value={val}
                                  onChange={e => setMetaEdits(prev => ({ ...prev, [key]: e.target.value }))}
                                  onBlur={() => setMetaEditingField(null)}
                                  onKeyDown={e => { if (e.key === 'Escape') setMetaEditingField(null); }}
                                  style={{ flex: 1, fontSize: 12, color: '#e2e8f0', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(99,102,241,0.4)', borderRadius: 5, padding: '4px 6px', resize: 'vertical', minHeight: 60, outline: 'none', fontFamily: 'inherit', lineHeight: 1.5 }}
                                />
                              ) : (
                                <span style={{ flex: 1, fontSize: 12, color: isActive ? "#e2e8f0" : "#7e92a8", lineHeight: 1.5 }}>
                                  {metaEdits[key] !== undefined ? <span style={{ color: '#fbbf24' }}>{val}</span> : val}
                                </span>
                              )}
                              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                                <button onClick={e => { e.stopPropagation(); setMetaEditingField(isEditing ? null : key); setMetaActiveVariants(v => ({ ...v, pt: i })); }} style={{
                                  padding: "3px 7px", borderRadius: 5, border: "none", cursor: "pointer", fontSize: 11,
                                  background: isEditing ? "rgba(99,102,241,0.2)" : "rgba(255,255,255,0.06)",
                                  color: isEditing ? "#a5b4fc" : "#4a5568",
                                }}>✏️</button>
                                <button onClick={e => { e.stopPropagation(); copyField(val, `pt${i}`); }} style={{
                                  padding: "3px 8px", borderRadius: 5, border: "none", cursor: "pointer", fontSize: 10,
                                  background: metaCopied[`pt${i}`] ? "rgba(52,211,153,0.15)" : "rgba(255,255,255,0.06)",
                                  color: metaCopied[`pt${i}`] ? "#34d399" : "#7e92a8",
                                }}>{metaCopied[`pt${i}`] ? "✓" : "Copy"}</button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <ScoreWidget outputId={"meta-copy-" + (metaResult.primaryTexts && metaResult.primaryTexts[0] ? metaResult.primaryTexts[0].slice(0,20) : "copy")} format="meta-copy" label="Rate this Meta copy" />

                    {/* Headlines */}
                    <div style={S.card}>
                      <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                        <span style={S.sectionLabel}>Headlines</span>
                        <span style={{ fontSize: 10, color: "#4a5568", marginLeft: 8 }}>40 chars · 3 variants</span>
                      </div>
                      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
                        {(metaResult.headlines || []).map((text, i) => {
                          const key = `hl-${i}`;
                          const val = metaEdits[key] !== undefined ? metaEdits[key] : text;
                          const isActive = metaActiveVariants.hl === i;
                          const isEditing = metaEditingField === key;
                          const over = val.length > 40;
                          return (
                            <div key={i} onClick={() => !isEditing && setMetaActiveVariants(v => ({ ...v, hl: i }))} style={{
                              padding: "10px 12px", borderRadius: 8, cursor: isEditing ? 'default' : "pointer",
                              background: isActive ? "rgba(99,102,241,0.08)" : "rgba(255,255,255,0.02)",
                              border: "1px solid " + (isActive ? "rgba(99,102,241,0.3)" : "rgba(255,255,255,0.06)"),
                              display: "flex", alignItems: "center", gap: 10, transition: "all 0.15s",
                            }}>
                              <span style={{ fontSize: 9, fontWeight: 800, color: isActive ? "#818cf8" : "#2d3748", flexShrink: 0 }}>HL{i+1}</span>
                              {isEditing ? (
                                <input autoFocus value={val}
                                  onChange={e => setMetaEdits(prev => ({ ...prev, [key]: e.target.value }))}
                                  onBlur={() => setMetaEditingField(null)}
                                  onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') setMetaEditingField(null); }}
                                  style={{ flex: 1, fontSize: 13, fontWeight: 600, color: over ? '#f87171' : '#e2e8f0', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(99,102,241,0.4)', borderRadius: 5, padding: '3px 6px', outline: 'none', fontFamily: 'inherit' }}
                                />
                              ) : (
                                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: isActive ? (over ? '#f87171' : '#e2e8f0') : '#7e92a8' }}>
                                  {metaEdits[key] !== undefined ? <span style={{ color: over ? '#f87171' : '#fbbf24' }}>{val}</span> : val}
                                </span>
                              )}
                              <span style={{ fontSize: 9, color: over ? '#f87171' : '#2d3748', flexShrink: 0 }}>{val.length}/40</span>
                              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                                <button onClick={e => { e.stopPropagation(); setMetaEditingField(isEditing ? null : key); setMetaActiveVariants(v => ({ ...v, hl: i })); }} style={{
                                  padding: "3px 7px", borderRadius: 5, border: "none", cursor: "pointer", fontSize: 11,
                                  background: isEditing ? "rgba(99,102,241,0.2)" : "rgba(255,255,255,0.06)",
                                  color: isEditing ? "#a5b4fc" : "#4a5568",
                                }}>✏️</button>
                                <button onClick={e => { e.stopPropagation(); copyField(val, `hl${i}`); }} style={{
                                  padding: "3px 8px", borderRadius: 5, border: "none", cursor: "pointer", fontSize: 10,
                                  background: metaCopied[`hl${i}`] ? "rgba(52,211,153,0.15)" : "rgba(255,255,255,0.06)",
                                  color: metaCopied[`hl${i}`] ? "#34d399" : "#7e92a8",
                                }}>{metaCopied[`hl${i}`] ? "✓" : "Copy"}</button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Descriptions */}
                    <div style={S.card}>
                      <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                        <span style={S.sectionLabel}>Link Descriptions</span>
                        <span style={{ fontSize: 10, color: "#4a5568", marginLeft: 8 }}>30 chars · 2 variants</span>
                      </div>
                      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
                        {(metaResult.descriptions || []).map((text, i) => {
                          const key = `desc-${i}`;
                          const val = metaEdits[key] !== undefined ? metaEdits[key] : text;
                          const isActive = metaActiveVariants.d === i;
                          const isEditing = metaEditingField === key;
                          const over = val.length > 30;
                          return (
                            <div key={i} onClick={() => !isEditing && setMetaActiveVariants(v => ({ ...v, d: i }))} style={{
                              padding: "10px 12px", borderRadius: 8, cursor: isEditing ? 'default' : "pointer",
                              background: isActive ? "rgba(99,102,241,0.08)" : "rgba(255,255,255,0.02)",
                              border: "1px solid " + (isActive ? "rgba(99,102,241,0.3)" : "rgba(255,255,255,0.06)"),
                              display: "flex", alignItems: "center", gap: 10, transition: "all 0.15s",
                            }}>
                              <span style={{ fontSize: 9, fontWeight: 800, color: isActive ? "#818cf8" : "#2d3748", flexShrink: 0 }}>D{i+1}</span>
                              {isEditing ? (
                                <input autoFocus value={val}
                                  onChange={e => setMetaEdits(prev => ({ ...prev, [key]: e.target.value }))}
                                  onBlur={() => setMetaEditingField(null)}
                                  onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') setMetaEditingField(null); }}
                                  style={{ flex: 1, fontSize: 12, color: over ? '#f87171' : '#e2e8f0', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(99,102,241,0.4)', borderRadius: 5, padding: '3px 6px', outline: 'none', fontFamily: 'inherit' }}
                                />
                              ) : (
                                <span style={{ flex: 1, fontSize: 12, color: isActive ? (over ? '#f87171' : '#e2e8f0') : '#7e92a8' }}>
                                  {metaEdits[key] !== undefined ? <span style={{ color: over ? '#f87171' : '#fbbf24' }}>{val}</span> : val}
                                </span>
                              )}
                              <span style={{ fontSize: 9, color: over ? '#f87171' : '#2d3748', flexShrink: 0 }}>{val.length}/30</span>
                              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                                <button onClick={e => { e.stopPropagation(); setMetaEditingField(isEditing ? null : key); setMetaActiveVariants(v => ({ ...v, d: i })); }} style={{
                                  padding: "3px 7px", borderRadius: 5, border: "none", cursor: "pointer", fontSize: 11,
                                  background: isEditing ? "rgba(99,102,241,0.2)" : "rgba(255,255,255,0.06)",
                                  color: isEditing ? "#a5b4fc" : "#4a5568",
                                }}>✏️</button>
                                <button onClick={e => { e.stopPropagation(); copyField(val, `d${i}`); }} style={{
                                  padding: "3px 8px", borderRadius: 5, border: "none", cursor: "pointer", fontSize: 10,
                                  background: metaCopied[`d${i}`] ? "rgba(52,211,153,0.15)" : "rgba(255,255,255,0.06)",
                                  color: metaCopied[`d${i}`] ? "#34d399" : "#7e92a8",
                                }}>{metaCopied[`d${i}`] ? "✓" : "Copy"}</button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Image + Reel */}
                    {metaResult.imageUrl && (
                      <div style={S.card}>
                        <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span style={S.sectionLabel}>Ad Creative</span>
                          <span style={{ fontSize: 10, padding: "2px 8px", background: "rgba(14,165,233,0.1)", border: "1px solid rgba(14,165,233,0.2)", borderRadius: 4, color: "#38bdf8", fontWeight: 700 }}>1:1 Feed</span>
                        </div>
                        <div style={{ padding: "16px", display: "flex", gap: 12, alignItems: "flex-start" }}>
                          <div style={{ position: "relative", flexShrink: 0 }}>
                          {/* ── Image variations grid (Pro: 2x2, Free: 1x1) ── */}
                          {metaImagesLoading && (!metaResult.imageVariations || metaResult.imageVariations.length === 0) && (
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, width: 372, marginBottom: 8 }}>
                              {[0,1,2,3,4,5].map(i => (
                                <div key={i} style={{ aspectRatio: '1', borderRadius: 6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                  <div style={{ fontSize: 9, color: '#2d3748', animation: 'pulse 1.5s ease-in-out infinite' }}>generating…</div>
                                </div>
                              ))}
                            </div>
                          )}
                          {metaResult.imageVariations && metaResult.imageVariations.length > 1 ? (
                            <>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, width: 372 }}>
                              {metaResult.imageVariations.map((imgUrl, vi) => (
                                <div key={vi} onClick={(e) => { setActiveImageVariant(vi); tiktokSourceImageRef.current = metaResult?.imageVariations?.[vi] || null; setMetaResult(r => ({ ...r, imageUrl: imgUrl })); }} style={{
                                  position: "relative", cursor: "pointer", borderRadius: 6, overflow: "hidden",
                                  border: activeImageVariant === vi ? "2px solid #6366f1" : "2px solid transparent",
                                  transition: "border 0.15s",
                                }}>
                                  <img src={imgUrl} alt={"Variation " + (vi+1)} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block", pointerEvents: "none" }} onError={e => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.parentElement.style.border = '1px dashed rgba(255,255,255,0.08)'; }} />
                                  <div style={{ position: "absolute", top: 3, left: 3, background: activeImageVariant === vi ? "#6366f1" : vi === 0 && metaResult?.heroProductImage ? "rgba(251,191,36,0.8)" : vi === 1 && metaResult?.secondaryImage ? "rgba(251,146,60,0.8)" : vi < (metaResult?.heroProductImage ? (metaResult?.secondaryImage ? 5 : 4) : 3) ? "rgba(52,211,153,0.8)" : "rgba(0,0,0,0.5)", borderRadius: 4, padding: "1px 5px", fontSize: 9, color: "white", fontWeight: 700 }}>{vi === 0 && metaResult?.heroProductImage ? '📷' : vi === 1 && metaResult?.secondaryImage ? '🏠' : `${vi+1}`}</div>
                                  <button onClick={e => { e.stopPropagation(); setRemixSourceUrl(imgUrl); setRemixProduct(null); setRemixError(''); setRemixOpen(true);
                                    if (imagenParsedImages.length === 0 && url) {
                                      fetch('/api/scrape', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }).then(r => r.json()).then(d => { if (d.images?.length) setImagenParsedImages(d.images); }).catch(()=>{});
                                    } }} style={{
                                    position: 'absolute', bottom: 3, right: 3,
                                    padding: '2px 6px', fontSize: 9, fontWeight: 700, borderRadius: 4,
                                    background: 'rgba(99,102,241,0.85)', color: 'white',
                                    border: 'none', cursor: 'pointer',
                                  }}
                                  title="Remix — insert product into this scene"
                                  >🔀</button>
                                </div>
                              ))}
                            </div>
                            {/* Upload own assets button */}
                            {!metaResult.heroProductImage && (
                              <div style={{ fontSize: 9, color: '#4a5568', marginTop: 4, marginBottom: 2, lineHeight: 1.4 }}>
                                💡 No product images found on this site — upload your own below for best results
                              </div>
                            )}
                            <button onClick={async () => {
                              if (!isSignedIn) { setUpgradeFeature('imagen'); setShowUpgradeModal(true); return; }
                              if (!isPro) {
                                try {
                                  const r = await fetch('/api/usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'check', userId: user.id, feature: 'imagen' }) });
                                  const d = await r.json();
                                  if (!d.allowed) { setUpgradeFeature('imagen'); setShowUpgradeModal(true); return; }
                                } catch(_) {}
                              }
                              setImagenOpen(true); setImagenStep(1); setImagenUrlInput(url); setImagenPreview(null);
                            }} style={{
                              marginTop: 6, width: '100%', padding: '5px 0', fontSize: 9, fontWeight: 700,
                              background: 'rgba(99,102,241,0.15)', color: '#a5b4fc',
                              border: '1px solid rgba(99,102,241,0.3)', borderRadius: 6, cursor: 'pointer',
                            }}>✦ Create with own assets</button>
                            </>
                          ) : (
                            <div style={{ position: "relative", width: 120 }}>
                          <img src={metaResult.imageUrl} alt="Meta creative" style={{ width: 120, height: 120, objectFit: "cover", borderRadius: 8, flexShrink: 0 }} />
                          <button onClick={async () => {
                            if (!isSignedIn) { setUpgradeFeature('imagen'); setShowUpgradeModal(true); return; }
                            if (!isPro) {
                              // Check usage count before gating
                              try {
                                const r = await fetch('/api/usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: user.id, feature: 'imagen', action: 'check', plan }) });
                                const d = await r.json();
                                if (!d.allowed) { setUpgradeFeature('imagen'); setShowUpgradeModal(true); return; }
                              } catch(_) {} // fail open
                            }
                            setImagenOpen(true); setImagenStep(1); setImagenUrlInput(url); setImagenParsedImages([]); setImagenSelected(null); setImagenPreview(null); setImagenError('');
                          }} style={{
                            position: "absolute", bottom: 4, left: 0, right: 0,
                            fontSize: 9, fontWeight: 700, padding: "4px 0", borderRadius: "0 0 4px 4px",
                            background: "rgba(99,102,241,0.9)", color: "white",
                            border: "none", cursor: "pointer", width: "100%", textAlign: "center",
                          }}>{imagenPreview ? "✓ Imagen version" : "✦ Create with own assets"}</button>
                          </div>
                          )}
                          </div>
                          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
                            <div style={{ fontSize: 10, color: "#4a5568", textAlign: "center", lineHeight: 1.5, padding: "4px 8px", background: "rgba(14,165,233,0.06)", borderRadius: 6, border: "1px solid rgba(14,165,233,0.12)" }}>
                              💡 Download image first — attach it when Meta prompts during import
                            </div>
                            <button onClick={async () => {
                              try {
                                const res = await fetch(metaResult.imageUrl);
                                const blob = await res.blob();
                                const a = document.createElement('a');
                                a.href = URL.createObjectURL(blob);
                                a.download = 'meta-creative.png';
                                a.click();
                                URL.revokeObjectURL(a.href);
                              } catch(_) {
                                window.open(metaResult.imageUrl, '_blank');
                              }
                            }} style={{
                              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                              padding: "8px 14px", borderRadius: 7, fontSize: 11, fontWeight: 700,
                              background: "linear-gradient(135deg,#0ea5e9,#6366f1)", color: "white",
                              border: "none", cursor: "pointer",
                            }}>⬇ Download Image (attach during Meta import)</button>
                            {isPro && metaResult.imageUrl && (
                              <button onClick={async () => {
                                if (videoTask?.polling) return;
                                setVideoTask({ status: 'PENDING', polling: true });
                                try {
                                  const motionPrompt = (metaResult.headlines?.[0] || '') + ' — smooth cinematic product advertisement, subtle elegant motion';
                                  const r = await fetch('/api/runway', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageUrl: metaResult.imageUrl, prompt: motionPrompt, duration: 5 }) });
                                  const d = await r.json();
                                  if (!d.taskId) { setVideoTask({ status: 'FAILED' }); return; }
                                  // Poll for completion
                                  let attempts = 0;
                                  const poll = async () => {
                                    if (attempts++ > 30) { setVideoTask({ status: 'FAILED' }); return; }
                                    const pr = await fetch('/api/runway', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'poll', taskId: d.taskId }) });
                                    const pd = await pr.json();
                                    if (pd.status === 'SUCCEEDED') {
                                      setVideoTask({ status: 'SUCCEEDED', videoUrl: pd.videoUrl, polling: false });
                                    } else if (pd.status === 'FAILED') {
                                      setVideoTask({ status: 'FAILED', polling: false });
                                    } else {
                                      setVideoTask({ status: pd.status, progress: pd.progress, polling: true, taskId: d.taskId });
                                      setTimeout(poll, 3000);
                                    }
                                  };
                                  poll();
                                } catch(e) { setVideoTask({ status: 'FAILED', polling: false }); }
                              }} style={{
                                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                                padding: "8px 14px", borderRadius: 7, fontSize: 11, fontWeight: 700,
                                background: videoTask?.status === 'SUCCEEDED' ? "linear-gradient(135deg,#34d399,#059669)" : "linear-gradient(135deg,#7c3aed,#db2777)",
                                color: "white", border: "none", cursor: videoTask?.polling ? "wait" : "pointer",
                                opacity: videoTask?.polling ? 0.8 : 1,
                              }}>
                                {videoTask?.polling ? '⏳ Generating video...' : videoTask?.status === 'SUCCEEDED' ? '✓ Video ready' : '▶ Create Video'}
                              </button>
                            )}
                            {videoTask?.status === 'SUCCEEDED' && videoTask.videoUrl && (
                              <a href={videoTask.videoUrl} download="meta-ad-video.mp4" target="_blank" rel="noopener noreferrer" style={{
                                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                                padding: "8px 14px", borderRadius: 7, fontSize: 11, fontWeight: 700,
                                background: "rgba(52,211,153,0.15)", color: "#34d399",
                                border: "1px solid rgba(52,211,153,0.3)", textDecoration: "none",
                              }}>⬇ Download Video</a>
                            )}
                            <button onClick={() => {
                              const rows2 = (metaResult.primaryTexts || []).map((pt, i) => [
                                "", row.campaign || "RSA Studio Campaign", "ACTIVE", "Traffic", "AUCTION",
                                "", "", "", "Yes",
                                "", "", "", "", "",
                                "ACTIVE", "", (row.campaign || "RSA Studio") + " - Ad Set",
                                "", "", "", "", "", "",
                                url, (() => { try { return new URL(url).hostname.replace("www.",""); } catch(_){return "";} })(),
                                "", "", "", "", "", "", "", "", "",
                                "LANDING_PAGE_VIEWS", "", "IMPRESSIONS",
                                "", "", "",
                                "ACTIVE", "", "",
                                `Meta Ad ${i + 1}`, pt, metaResult.headlines?.[i] || metaResult.headlines?.[0] || "",
                                "", "", "Page Post Ad",
                                "", "", "", "LEARN_MORE",
                                "", "", "", "",
                              ]);
                              const csv2 = "Campaign ID	Campaign Name	Campaign Status	Campaign Objective	Buying Type	Campaign Daily Budget	Campaign Bid Strategy	Campaign Start Time	New Objective	Buy With Prime Type	Is Budget Scheduling Enabled For Campaign	Campaign High Demand Periods	Buy With Integration Partner	Ad Set ID	Ad Set Run Status	Ad Set Lifetime Impressions	Ad Set Name	Ad Set Time Start	Destination Type	Use Accelerated Delivery	Is Budget Scheduling Enabled For Ad Set	Ad Set High Demand Periods	Link Object ID	Link	Display Link	Countries	Location Types	Age Min	Age Max	Excluded Custom Audiences	Advantage Audience	Age Range	Targeting Optimization	Brand Safety Inventory Filtering Levels	Optimization Goal	Attribution Spec	Billing Event	Regional Regulated Categories	Story ID	Ad ID	Ad Status	Preview Link	Instagram Preview Link	Ad Name	Body	Title	Optimize text per person	Optimized Ad Creative	Creative Type	URL Tags	Video ID	Instagram Account ID	Call to Action	Additional Custom Tracking Specs	Video Retargeting	Permalink	Use Page as Actor\n" + rows2.map(row => row.map(v => String(v).replace(/\t/g, " ").replace(/\n/g, " ")).join("\t")).join("\n");
                              const blob = new Blob([csv2], { type: "text/plain" });
                              const a = document.createElement("a");
                              a.href = URL.createObjectURL(blob);
                              a.download = "meta-ads-export.txt";
                              a.click();
                            }} style={{
                              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                              padding: "8px 14px", borderRadius: 7, fontSize: 11, fontWeight: 700,
                              background: "rgba(255,255,255,0.06)", color: "#94a3b8",
                              border: "1px solid rgba(255,255,255,0.08)", cursor: "pointer",
                            }}>⬇ Download CSV for Meta</button>
                          </div>
                        <ScoreWidget outputId={"meta-img-" + (metaResult.imageUrl ? metaResult.imageUrl.slice(-20) : "img")} format="meta-image" label="Rate this image" />
                        </div>
                      </div>
                    )}

                    {/* Regenerate */}
                    <div style={{ textAlign: "center", paddingBottom: 8 }}>
                      <button onClick={() => { setMetaResult(null); setGenerateMeta(true); setAdFormat("rsa");
                        setTimeout(() => document.querySelector('[data-tab="rsa"]')?.click(), 50);
                      }} style={{
                        fontSize: 11, color: "#4a5568", background: "none", border: "none", cursor: "pointer",
                      }}>← Back to Google ads · regenerate Meta from RSA tab</button>
                    </div>
                  </>
                );
              })()}
            </div>
          )}

        </div>
      </div>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <div style={{ textAlign: 'center', padding: '12px 24px', borderTop: '1px solid rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, color: '#2d3748' }}>AI Ad Studio</span>
        <span style={{ fontSize: 10, color: '#1e293b' }}>·</span>
        <a href="https://app.termly.io/dashboard/website/3a01a18a-2820-4b2c-ab90-d722bbcd93d8/privacy-policy" target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: '#2d3748', textDecoration: 'none' }}
          onMouseOver={e => e.target.style.color='#4a5568'}
          onMouseOut={e => e.target.style.color='#2d3748'}>Privacy Policy</a>
        <span style={{ fontSize: 10, color: '#1e293b' }}>·</span>
        <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: '#2d3748', textDecoration: 'none' }}
          onMouseOver={e => e.target.style.color='#4a5568'}
          onMouseOut={e => e.target.style.color='#2d3748'}>Terms of Use</a>
        <span style={{ fontSize: 10, color: '#1e293b' }}>·</span>
        <span style={{ fontSize: 10, color: '#2d3748' }}>© 2026 theaiad.studio</span>
      </div>
      {showGateModal && <GateModal />}
      {showAuthModal && <AuthModal />}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes metaPulse {
          0%, 100% { box-shadow: 0 0 0 0px rgba(14,165,233,0.0); }
          50% { box-shadow: 0 0 0 4px rgba(14,165,233,0.5), 0 0 10px rgba(14,165,233,0.3); }
        }
        @keyframes audiencePulse {
          0%, 100% { opacity: 1; border-color: rgba(245,158,11,0.4); }
          50% { opacity: 0.7; border-color: rgba(245,158,11,0.8); }
        }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.75; } }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 10px; }
      `}</style>
      {/* ── Upgrade Modal ─────────────────────────────────────────── */}
      {showUpgradeModal && (
        <div onClick={() => setShowUpgradeModal(false)} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)",
          backdropFilter: "blur(6px)", zIndex: 1001,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: "#0f1623", border: "1px solid rgba(99,102,241,0.4)",
            borderRadius: 16, width: "100%", maxWidth: 480,
            boxShadow: "0 24px 64px rgba(0,0,0,0.6)", overflow: "hidden",
          }}>
            {/* Header */}
            <div style={{ background: "linear-gradient(135deg,rgba(99,102,241,0.2),rgba(14,165,233,0.2))", padding: "24px 24px 20px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#6366f1", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>Upgrade to Pro</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#e2e8f0", letterSpacing: "-0.02em" }}>
                {upgradeFeature === 'imagen' ? "✦ Imagen is a Pro feature" :
                 upgradeFeature === 'batch' ? "📦 Batch upload is a Pro feature" :
                 upgradeFeature === 'api' ? "⚡ API access is a Pro feature" :
                 "🚀 Unlock Pro features"}
              </div>
              <div style={{ fontSize: 12, color: "#7e92a8", marginTop: 6 }}>
                {upgradeFeature === 'imagen' ? "You've used your 5 free Imagen generations. Upgrade for unlimited." :
                 upgradeFeature === 'batch' ? "Process multiple URLs at once with the batch uploader." :
                 "Get unlimited access to all RSA Studio features."}
              </div>
            </div>

            {/* Plan toggle */}
            <div style={{ padding: "20px 24px 0" }}>
              <div style={{ display: "flex", background: "rgba(255,255,255,0.04)", borderRadius: 10, padding: 4, marginBottom: 20 }}>
                {["monthly","annual"].map(p => (
                  <button key={p} onClick={() => setUpgradePlan(p)} style={{
                    flex: 1, padding: "8px 0", fontSize: 12, fontWeight: 700, borderRadius: 7,
                    cursor: "pointer", transition: "all 0.2s", border: "none",
                    background: upgradePlan === p ? "linear-gradient(135deg,#6366f1,#0ea5e9)" : "transparent",
                    color: upgradePlan === p ? "white" : "#4a5568",
                  }}>
                    {p === "monthly" ? "€69 / month" : "€590 / year"}
                    {p === "annual" && <span style={{ fontSize: 9, marginLeft: 6, background: "rgba(52,211,153,0.2)", color: "#34d399", padding: "1px 5px", borderRadius: 10 }}>Save 29%</span>}
                  </button>
                ))}
              </div>

              {/* Features list */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 20 }}>
                {[
                  "✦ Unlimited Imagen generations",
                  "📦 Batch URL uploader",
                  "⚡ API access",
                  "🎯 Ad & image library",
                  "📈 Performance library",
                  "∞ Unlimited RSA & Meta ads",
                  "🔍 Advanced domain scan",
                  "💬 Priority support",
                ].map(f => (
                  <div key={f} style={{ fontSize: 11, color: "#7e92a8", display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ color: "#34d399", fontSize: 10 }}>✓</span>{f}
                  </div>
                ))}
              </div>

              {/* Trial note */}
              <div style={{ fontSize: 10, color: "#4a5568", textAlign: "center", marginBottom: 16 }}>
                🎁 30-day free trial — cancel anytime, no questions asked
              </div>
            </div>

            {/* CTA */}
            <div style={{ padding: "0 24px 24px" }}>
              <button onClick={async () => {
                if (!isSignedIn) { setShowUpgradeModal(false); setShowAuthModal(true); return; }
                setUpgradeLoading(true);
                try {
                  const r = await fetch('/api/stripe-checkout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ plan: upgradePlan, userId: user.id, email: user.primaryEmailAddress?.emailAddress }),
                  });
                  const d = await r.json();
                  if (d.url) window.location.href = d.url;
                  else alert(d.error || 'Checkout failed');
                } catch(e) { alert(e.message); }
                setUpgradeLoading(false);
              }} style={{
                width: "100%", padding: "14px", fontSize: 14, fontWeight: 800,
                background: upgradeLoading ? "rgba(99,102,241,0.3)" : "linear-gradient(135deg,#6366f1,#0ea5e9)",
                color: "white", border: "none", borderRadius: 10, cursor: upgradeLoading ? "default" : "pointer",
                boxShadow: "0 4px 20px rgba(99,102,241,0.4)", transition: "all 0.3s",
              }}>
                {upgradeLoading ? "Redirecting to checkout..." : `Start free trial — ${upgradePlan === 'annual' ? '€590/yr' : '€69/mo'}`}
              </button>
              <button onClick={() => setShowUpgradeModal(false)} style={{
                width: "100%", marginTop: 10, padding: "10px", fontSize: 12,
                background: "none", border: "none", color: "#4a5568", cursor: "pointer",
              }}>Maybe later</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Upgrade Success Banner ─────────────────────────────────── */}
      {typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('upgraded') === 'true' && (
        <div style={{
          position: "fixed", top: 20, left: "50%", transform: "translateX(-50%)",
          background: "linear-gradient(135deg,#059669,#10b981)", color: "white",
          padding: "12px 24px", borderRadius: 10, fontSize: 13, fontWeight: 700,
          boxShadow: "0 4px 20px rgba(16,185,129,0.4)", zIndex: 1002,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          🎉 Welcome to Pro! All features are now unlocked.
        </div>
      )}

      {/* ── Feedback Dashboard Modal ─────────────────────────────── */}
      {showFeedbackDash && (
        <div onClick={() => setShowFeedbackDash(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
          backdropFilter: 'blur(6px)', zIndex: 1001,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: '#0f1623', border: '1px solid rgba(99,102,241,0.3)',
            borderRadius: 16, width: '100%', maxWidth: 700, maxHeight: '85vh',
            overflow: 'hidden', display: 'flex', flexDirection: 'column',
            boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          }}>
            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#e2e8f0' }}>📊 Feedback Dashboard</div>
                <div style={{ fontSize: 11, color: '#4a5568', marginTop: 2 }}>
                  {feedbackDashData.length} responses · avg score: {feedbackDashData.length ? (feedbackDashData.reduce((s, e) => s + e.score, 0) / feedbackDashData.length).toFixed(1) : '—'} / 5
                </div>
              </div>
              <button onClick={() => setShowFeedbackDash(false)} style={{ background: 'none', border: 'none', color: '#4a5568', fontSize: 20, cursor: 'pointer' }}>✕</button>
            </div>
            {/* Summary */}
            <div style={{ padding: '12px 24px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', gap: 16, flexShrink: 0 }}>
              {['rsa', 'meta-copy', 'meta-image'].map(fmt => {
                const entries = feedbackDashData.filter(e => e.format === fmt);
                const avg = entries.length ? (entries.reduce((s, e) => s + e.score, 0) / entries.length).toFixed(1) : '—';
                return (
                  <div key={fmt} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: '8px 14px', textAlign: 'center' }}>
                    <div style={{ fontSize: 9, color: '#4a5568', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{fmt === 'rsa' ? 'RSA Copy' : fmt === 'meta-copy' ? 'Meta Copy' : 'Image'}</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: '#e2e8f0', marginTop: 2 }}>{avg}</div>
                    <div style={{ fontSize: 9, color: '#4a5568' }}>{entries.length} ratings</div>
                  </div>
                );
              })}
            </div>
            {/* Entries */}
            <div style={{ overflowY: 'auto', padding: '12px 16px', flex: 1 }}>
              {feedbackDashData.map((entry, i) => (
                <div key={i} style={{ padding: '10px 14px', borderRadius: 8, marginBottom: 6, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ fontSize: 14, color: '#f59e0b', flexShrink: 0 }}>{'★'.repeat(entry.score)}{'☆'.repeat(5 - entry.score)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, color: '#7e92a8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.format} · {(() => { try { return new URL(entry.url).hostname; } catch(_) { return entry.url || '—'; } })()}
                    </div>
                    {entry.comment && <div style={{ fontSize: 11, color: '#e2e8f0', marginTop: 3 }}>{entry.comment}</div>}
                  </div>
                  <div style={{ fontSize: 9, color: '#2d3748', flexShrink: 0 }}>{new Date(entry.timestamp).toLocaleDateString()}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Audience Brief Modal ──────────────────────────────────────── */}
      {showAudienceBrief && audienceBrief && (
        <div onClick={() => setShowAudienceBrief(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
          backdropFilter: 'blur(6px)', zIndex: 1001,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: '#0f1623', border: '1px solid rgba(99,102,241,0.3)',
            borderRadius: 16, width: '100%', maxWidth: 680, maxHeight: '88vh',
            overflow: 'hidden', display: 'flex', flexDirection: 'column',
            boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          }}>
            {/* Header */}
            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#e2e8f0' }}>🎯 {audienceBrief.audienceName}</div>
                <div style={{ fontSize: 11, color: '#4a5568', marginTop: 2 }}>Audience brief — <span style={{ color: '#fbbf24' }}>fields are editable</span> — feeds into ad copy generation</div>
              </div>
              <button onClick={() => setShowAudienceBrief(false)} style={{ background: 'none', border: 'none', color: '#4a5568', fontSize: 20, cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ overflowY: 'auto', padding: '16px 24px', flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>

              {/* Meta Advantage+ Description — copy-paste ready */}
              <div style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: 10, padding: '14px 16px' }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: '#818cf8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
                  ✦ Meta Advantage+ — "Describe Your Audience" (ready to paste)
                </div>
                <textarea
                  value={audienceBriefEdits.metaDescription !== undefined ? audienceBriefEdits.metaDescription : audienceBrief.metaDescription}
                  onChange={e => setAudienceBriefEdits(prev => ({ ...prev, metaDescription: e.target.value }))}
                  rows={3}
                  style={{
                    width: '100%', fontSize: 12, color: audienceBriefEdits.metaDescription !== undefined ? '#fbbf24' : '#e2e8f0',
                    lineHeight: 1.6, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 6, padding: '6px 8px', outline: 'none', resize: 'vertical',
                    fontFamily: 'inherit', boxSizing: 'border-box',
                  }}
                />
                <button onClick={() => navigator.clipboard.writeText(audienceBriefEdits.metaDescription !== undefined ? audienceBriefEdits.metaDescription : audienceBrief.metaDescription)} style={{
                  marginTop: 8, padding: '4px 10px', fontSize: 10, fontWeight: 700, borderRadius: 5,
                  background: 'rgba(99,102,241,0.2)', color: '#a5b4fc', border: '1px solid rgba(99,102,241,0.3)', cursor: 'pointer',
                }}>Copy</button>
              </div>

              {/* Demographics + Psychographics */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: '#7e92a8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Demographics</div>
                  {[
                    ['Age', 'ageRange', audienceBrief.demographics?.ageRange],
                    ['Gender', 'gender', audienceBrief.demographics?.gender],
                    ['Income', 'income', audienceBrief.demographics?.income],
                    ['Locations', 'locations', (audienceBrief.demographics?.locations || []).join(', ')],
                  ].map(([label, field, val]) => val ? (
                    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5, fontSize: 11, gap: 8 }}>
                      <span style={{ color: '#4a5568', fontWeight: 700, flexShrink: 0 }}>{label}</span>
                      <input
                        value={audienceBriefEdits[field] !== undefined ? audienceBriefEdits[field] : val}
                        onChange={e => setAudienceBriefEdits(prev => ({ ...prev, [field]: e.target.value }))}
                        style={{
                          flex: 1, textAlign: 'right', background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4,
                          color: audienceBriefEdits[field] !== undefined ? '#fbbf24' : '#e2e8f0',
                          fontSize: 11, padding: '2px 6px', outline: 'none',
                        }}
                      />
                    </div>
                  ) : null)}
                </div>
                <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: '#7e92a8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Messaging Tone</div>
                  <input
                    value={audienceBriefEdits.messagingTone !== undefined ? audienceBriefEdits.messagingTone : audienceBrief.messagingTone}
                    onChange={e => setAudienceBriefEdits(prev => ({ ...prev, messagingTone: e.target.value }))}
                    style={{
                      width: '100%', fontSize: 11, lineHeight: 1.5, marginBottom: 10,
                      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 4, color: audienceBriefEdits.messagingTone !== undefined ? '#fbbf24' : '#e2e8f0',
                      padding: '3px 6px', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
                    }}
                  />
                  <div style={{ fontSize: 10, fontWeight: 800, color: '#7e92a8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Copy Angles</div>
                  {(audienceBrief.copySignals || []).map((s, i) => (
                    <div key={i} style={{ fontSize: 11, color: '#a5b4fc', marginBottom: 4 }}>→ {s}</div>
                  ))}
                </div>
              </div>

              {/* Interests + Behaviors */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: '#7e92a8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Interests</div>
                  {(audienceBrief.interests || []).map((item, i) => (
                    <div key={i} style={{ fontSize: 11, color: '#e2e8f0', padding: '3px 8px', background: 'rgba(99,102,241,0.1)', borderRadius: 5, marginBottom: 4, display: 'inline-block', marginRight: 4 }}>{item}</div>
                  ))}
                </div>
                <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: '#7e92a8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Pain Points</div>
                  {(audienceBrief.painPoints || []).map((item, i) => (
                    <div key={i} style={{ fontSize: 11, color: '#f87171', marginBottom: 5 }}>✗ {item}</div>
                  ))}
                  <div style={{ fontSize: 10, fontWeight: 800, color: '#7e92a8', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '10px 0 6px' }}>Motivations</div>
                  {(audienceBrief.motivations || []).map((item, i) => (
                    <div key={i} style={{ fontSize: 11, color: '#34d399', marginBottom: 5 }}>✓ {item}</div>
                  ))}
                </div>
              </div>

              {/* Psychographics */}
              <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: '#7e92a8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Psychographic Profile</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {(audienceBrief.psychographics || []).map((item, i) => (
                    <span key={i} style={{ fontSize: 11, color: '#fbbf24', padding: '3px 10px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 20 }}>{item}</span>
                  ))}
                </div>
              </div>

            </div>

            {/* Footer — generate with brief */}
            <div style={{ padding: '14px 24px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', gap: 10, flexShrink: 0 }}>
              <button onClick={() => {
                  // Merge edits into the brief before using
                  if (Object.keys(audienceBriefEdits).length > 0) {
                    setAudienceBrief(prev => ({
                      ...prev,
                      metaDescription: audienceBriefEdits.metaDescription ?? prev.metaDescription,
                      messagingTone: audienceBriefEdits.messagingTone ?? prev.messagingTone,
                      demographics: {
                        ...prev.demographics,
                        ageRange: audienceBriefEdits.ageRange ?? prev.demographics?.ageRange,
                        gender: audienceBriefEdits.gender ?? prev.demographics?.gender,
                        income: audienceBriefEdits.income ?? prev.demographics?.income,
                        locations: audienceBriefEdits.locations ? audienceBriefEdits.locations.split(',').map(s => s.trim()) : prev.demographics?.locations,
                      },
                    }));
                  }
                  setShowAudienceBrief(false);
                }} style={{
                flex: 1, padding: '10px', fontSize: 12, fontWeight: 700, borderRadius: 8,
                background: 'linear-gradient(135deg,#3b82f6,#6366f1)', color: 'white',
                border: 'none', cursor: 'pointer',
              }}>✓ Use this brief — close and generate</button>
              <button onClick={() => { setAudienceBrief(null); setShowAudienceBrief(false); }} style={{
                padding: '10px 16px', fontSize: 12, borderRadius: 8,
                background: 'rgba(255,255,255,0.05)', color: '#4a5568',
                border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer',
              }}>Clear</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Library Modal ────────────────────────────────────────────── */}
      {showLibrary && (
        <div onClick={() => setShowLibrary(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
          backdropFilter: 'blur(6px)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: '#0f1623', border: '1px solid rgba(245,158,11,0.3)',
            borderRadius: 16, width: '100%', maxWidth: 600, maxHeight: '85vh',
            overflow: 'hidden', display: 'flex', flexDirection: 'column',
            boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          }}>
            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#e2e8f0' }}>★ Saved Library</div>
                <div style={{ fontSize: 11, color: '#4a5568', marginTop: 2 }}>{library.length} saved output{library.length !== 1 ? 's' : ''} — click Replay to reload</div>
              </div>
              <button onClick={() => setShowLibrary(false)} style={{ background: 'none', border: 'none', color: '#4a5568', fontSize: 20, cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ overflowY: 'auto', padding: '12px 16px', flex: 1 }}>
              {library.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: '#4a5568' }}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>☆</div>
                  <div style={{ fontSize: 14, color: '#7e92a8' }}>No saved outputs yet</div>
                  <div style={{ fontSize: 11, marginTop: 6 }}>Click ☆ on any history entry to save it</div>
                </div>
              ) : library.map(entry => (
                <div key={entry.id} style={{
                  padding: '12px 14px', borderRadius: 10, marginBottom: 8,
                  background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
                  display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  {entry.metaResult && entry.metaResult.imageUrl && (
                    <img src={entry.metaResult.imageUrl} alt="" style={{ width: 48, height: 48, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }} />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {(() => { try { return new URL(entry.url).hostname.replace('www.',''); } catch(_) { return entry.url; } })()}
                    </div>
                    <div style={{ fontSize: 10, color: '#4a5568', marginTop: 2 }}>
                      {entry.rows && entry.rows[0] && entry.rows[0].headlines && entry.rows[0].headlines[0] && entry.rows[0].headlines[0].text ? entry.rows[0].headlines[0].text.slice(0, 50) : entry.metaResult && entry.metaResult.headlines && entry.metaResult.headlines[0] ? entry.metaResult.headlines[0].slice(0, 50) : ''}
                    </div>
                    <div style={{ fontSize: 9, color: '#2d3748', marginTop: 3, display: 'flex', gap: 8 }}>
                      <span>{entry.format === 'pmax' ? '◈ PMax' : entry.metaResult ? '◉ Meta' : '◎ RSA'}</span>
                      <span>{entry.savedAt ? new Date(entry.savedAt).toLocaleDateString() : entry.timestamp}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button onClick={() => {
                      setRows(entry.rows);
                      setActiveRow(0);
                      setUrl(entry.url);
                      setGenerated(true);
                      if (entry.format) setAdFormat(entry.format);
                      if (entry.metaResult) { setMetaResult(entry.metaResult); setMetaError(''); }
                      setShowLibrary(false);
                    }} style={{
                      padding: '6px 12px', fontSize: 11, fontWeight: 700, borderRadius: 7,
                      background: 'linear-gradient(135deg,rgba(99,102,241,0.3),rgba(14,165,233,0.3))',
                      color: '#a5b4fc', border: '1px solid rgba(99,102,241,0.4)', cursor: 'pointer',
                    }}>▶ Replay</button>
                    <button onClick={async () => {
                      await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', userId: user.id, entryId: entry.id }) });
                      setLibrary(prev => prev.filter(e => e.id !== entry.id));
                    }} style={{
                      padding: '6px 8px', fontSize: 11, borderRadius: 7,
                      background: 'rgba(255,255,255,0.04)', color: '#4a5568',
                      border: '1px solid rgba(255,255,255,0.07)', cursor: 'pointer',
                    }}>✕</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Remix Modal ──────────────────────────────────────────────────── */}
      {remixOpen && (
        <div onClick={() => setRemixOpen(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
          backdropFilter: 'blur(6px)', zIndex: 1002,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: '#0f1623', border: '1px solid rgba(99,102,241,0.3)',
            borderRadius: 16, width: '100%', maxWidth: 580, maxHeight: '88vh',
            overflow: 'hidden', display: 'flex', flexDirection: 'column',
            boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          }}>
            {/* Header */}
            <div style={{ padding: '18px 24px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 800, color: '#e2e8f0' }}>🔀 Remix — Insert Product into Scene</div>
                <div style={{ fontSize: 11, color: '#4a5568', marginTop: 2 }}>Select a product image to insert into the lifestyle scene</div>
              </div>
              <button onClick={() => setRemixOpen(false)} style={{ background: 'none', border: 'none', color: '#4a5568', fontSize: 20, cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ overflowY: 'auto', padding: '16px 24px', flex: 1 }}>

              {/* Scene preview */}
              {remixSourceUrl && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#4a5568', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Scene to remix into</div>
                  <img src={remixSourceUrl} alt="scene" style={{ width: '100%', maxHeight: 260, objectFit: 'contain', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.3)' }} />
                </div>
              )}

              {/* Product picker */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#4a5568', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
                  Select product to insert {imagenParsedImages.length === 0 && '— scrape a URL first to load product images'}
                </div>
                {imagenParsedImages.length > 0 ? (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
                      {imagenParsedImages.map((img, i) => (
                        <div key={i} onClick={() => setRemixProduct(img)} style={{
                          aspectRatio: '1', borderRadius: 6, overflow: 'hidden', cursor: 'pointer',
                          border: remixProduct === img ? '2px solid #6366f1' : '2px solid rgba(255,255,255,0.06)',
                          transition: 'border 0.15s', position: 'relative',
                        }}>
                          <img src={img} alt={'product ' + i} style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#fff' }} />
                          {remixProduct === img && (
                            <div style={{ position: 'absolute', inset: 0, background: 'rgba(99,102,241,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 800, color: 'white' }}>✓</div>
                          )}
                        </div>
                      ))}
                    </div>
                    {remixProduct && (
                      <div style={{ marginTop: 8, fontSize: 10, color: '#34d399' }}>✓ Product selected — click Generate Remix below</div>
                    )}
                  </>
                ) : (
                  <div style={{ padding: '20px', textAlign: 'center', background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ fontSize: 11, color: '#4a5568', marginBottom: 10 }}>No product images loaded yet</div>
                    <button onClick={async () => {
                      const scrapeUrl = url || (() => { try { const u = new URL(remixSourceUrl || ''); return u.origin; } catch(_) { return null; } })();
                      if (!scrapeUrl) return;
                      try {
                        const r = await fetch('/api/scrape', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: scrapeUrl }) });
                        const d = await r.json();
                        const imgs = d.images || [];
                        if (imgs.length > 0) setImagenParsedImages(imgs);
                      } catch(_) {}
                    }} style={{ padding: '7px 16px', fontSize: 11, fontWeight: 700, borderRadius: 7, background: 'rgba(99,102,241,0.15)', color: '#a5b4fc', border: '1px solid rgba(99,102,241,0.3)', cursor: 'pointer' }}>
                      Load product images from URL
                    </button>
                  </div>
                )}
              </div>

              {remixError && <div style={{ fontSize: 11, color: '#f87171', marginBottom: 12 }}>{remixError}</div>}
            </div>

            {/* Footer */}
            <div style={{ padding: '14px 24px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', gap: 10, flexShrink: 0 }}>
              <button onClick={async () => {
                if (!remixProduct || !remixSourceUrl) return;
                setRemixGenerating(true); setRemixError('');
                try {
                  const productDesc = metaResult?.headlines?.[0] || 'product';
                  const prompt = `Place the exact product from the reference image into the foreground of this lifestyle scene. The scene has an empty surface area in the foreground — position the product there. Keep the product's exact label, colours and shape. Size it proportionally to look natural in the scene, not too large. Add a soft shadow beneath it. Keep everything else in the scene unchanged.`;
                  const body = {
                    prompt,
                    sceneImageUrl: remixSourceUrl,
                    imageUrl: remixProduct,
                  };
                  const r = await fetch('/api/imagen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                  const d = await r.json();
                  if (d.imageUrl) {
                    setMetaResult(prev => {
                      if (!prev) return prev;
                      const variations = [...(prev.imageVariations || [])];
                      variations[activeImageVariant] = d.imageUrl;
                      return { ...prev, imageUrl: d.imageUrl, imageVariations: variations };
                    });
                    setRemixOpen(false);
                  } else {
                    setRemixError(d.error || 'Remix failed — try a different product image');
                  }
                } catch(e) { setRemixError(e.message); }
                setRemixGenerating(false);
              }} disabled={!remixProduct || remixGenerating} style={{
                flex: 1, padding: '10px', fontSize: 12, fontWeight: 700, borderRadius: 8,
                background: !remixProduct || remixGenerating ? 'rgba(255,255,255,0.05)' : 'linear-gradient(135deg,#6366f1,#0ea5e9)',
                color: !remixProduct || remixGenerating ? '#4a5568' : 'white',
                border: 'none', cursor: !remixProduct || remixGenerating ? 'not-allowed' : 'pointer',
              }}>
                {remixGenerating ? '⏳ Generating remix...' : '🔀 Generate Remix'}
              </button>
              <button onClick={() => setRemixOpen(false)} style={{ padding: '10px 16px', fontSize: 12, borderRadius: 8, background: 'rgba(255,255,255,0.05)', color: '#4a5568', border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Imagen Modal ──────────────────────────────────────────── */}
      {imagenOpen && (
        <div onClick={() => setImagenOpen(false)} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)",
          backdropFilter: "blur(6px)", zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: "#0f1623", border: "1px solid rgba(99,102,241,0.3)",
            borderRadius: 16, width: "100%", maxWidth: 560, maxHeight: "90vh",
            overflow: "auto", boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
          }}>
            <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#e2e8f0" }}>✦ Recreate with Imagen</div>
                <div style={{ fontSize: 11, color: "#4a5568", marginTop: 2 }}>
                  {imagenStep === 1 ? "Step 1 — Choose a product image" :
                   imagenStep === 2 ? "Step 2 — Select an image" :
                   imagenStep === 3 ? "Step 3 — Style your scene" : "Step 4 — Preview & confirm"}
                </div>
              </div>
              <button onClick={() => setImagenOpen(false)} style={{ background: "none", border: "none", color: "#4a5568", fontSize: 20, cursor: "pointer" }}>✕</button>
            </div>
            <div style={{ display: "flex", gap: 6, padding: "12px 24px 0" }}>
              {[1,2,3,4].map(s => (
                <div key={s} style={{
                  flex: 1, height: 3, borderRadius: 2,
                  background: s <= imagenStep ? "linear-gradient(90deg,#6366f1,#0ea5e9)" : "rgba(255,255,255,0.08)",
                  transition: "all 0.3s",
                }} />
              ))}
            </div>
            <div style={{ padding: "20px 24px 24px" }}>

              {imagenStep === 1 && (
                <div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                    {["upload","url"].map(t => (
                      <button key={t} onClick={() => setImagenTab(t)} style={{
                        flex: 1, padding: "8px 0", fontSize: 12, fontWeight: 700,
                        borderRadius: 8, cursor: "pointer", transition: "all 0.2s",
                        background: imagenTab === t ? "linear-gradient(135deg,rgba(99,102,241,0.3),rgba(14,165,233,0.3))" : "rgba(255,255,255,0.04)",
                        color: imagenTab === t ? "#a5b4fc" : "#4a5568",
                        border: imagenTab === t ? "1px solid rgba(99,102,241,0.4)" : "1px solid rgba(255,255,255,0.06)",
                      }}>{t === "upload" ? "📁 Upload Image" : "🔗 Capture from URL"}</button>
                    ))}
                  </div>
                  {imagenTab === "upload" ? (
                    <div>
                      <input type="file" accept="image/jpeg,image/png,image/webp" style={{ display: "none" }} id="imagen-upload"
                        onChange={e => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          const reader = new FileReader();
                          reader.onload = ev => {
                            const dataUrl = ev.target.result;
                            setImagenSelected({ src: dataUrl, base64: dataUrl.split(',')[1], mimeType: file.type });
                            setImagenStep(3);
                          };
                          reader.readAsDataURL(file);
                        }}
                      />
                      <label htmlFor="imagen-upload" style={{
                        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                        gap: 10, padding: imagenSelected?.src ? "12px" : "40px 20px", borderRadius: 12, cursor: "pointer",
                        border: imagenSelected?.src ? "2px solid rgba(99,102,241,0.5)" : "2px dashed rgba(99,102,241,0.3)",
                        background: imagenSelected?.src ? "rgba(99,102,241,0.08)" : "rgba(99,102,241,0.04)",
                        minHeight: 160,
                      }}>
                        {imagenSelected?.src ? (
                          <img src={imagenSelected.src} alt="preview" style={{ maxWidth: "100%", maxHeight: 200, objectFit: "contain", borderRadius: 8 }} />
                        ) : (
                          <>
                            <span style={{ fontSize: 36 }}>📸</span>
                            <span style={{ fontSize: 13, color: "#7e92a8", textAlign: "center" }}>Click to upload a product image<br/><span style={{ fontSize: 11, color: "#4a5568" }}>JPG, PNG or WebP — max 5MB</span></span>
                          </>
                        )}
                      </label>
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontSize: 11, color: "#7e92a8", marginBottom: 8 }}>Parse product images from your URL:</div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <input value={imagenUrlInput} onChange={e => setImagenUrlInput(e.target.value)}
                          placeholder="https://your-product-url.com"
                          style={{ flex: 1, padding: "10px 12px", borderRadius: 8, fontSize: 12, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", color: "#e2e8f0", outline: "none" }}
                        />
                        <button onClick={async () => {
                          if (!imagenUrlInput) return;
                          setImagenParsing(true); setImagenError('');
                          try {
                            const r = await fetch('/api/scrape', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: imagenUrlInput }) });
                            const d = await r.json();
                            const imgs = (d.images || []).filter(s => s && s.startsWith('http')).slice(0, 12);
                            if (!imgs.length) setImagenError('No images found at this URL');
                            setImagenParsedImages(imgs);
                            if (imgs.length) setImagenStep(2);
                          } catch(e) { setImagenError('Failed to parse URL'); }
                          setImagenParsing(false);
                        }} style={{ padding: "10px 16px", fontSize: 12, fontWeight: 700, borderRadius: 8, background: "linear-gradient(135deg,rgba(99,102,241,0.3),rgba(14,165,233,0.3))", color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.4)", cursor: "pointer" }}>
                          {imagenParsing ? "Parsing..." : "Parse"}
                        </button>
                      </div>
                      {imagenError && <div style={{ fontSize: 11, color: "#f87171", marginTop: 8 }}>{imagenError}</div>}
                    </div>
                  )}
                </div>
              )}

              {imagenStep === 2 && (
                <div>
                  <div style={{ fontSize: 11, color: "#7e92a8", marginBottom: 12 }}>Select a product image to use as reference:</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
                    {imagenParsedImages.map((src, i) => (
                      <div key={i} onClick={() => {
                        // For URL-parsed images, just store the URL — server will fetch it
                        setImagenSelected({ src, imageUrl: src, base64: null, mimeType: 'image/jpeg' });
                        setImagenStep(3);
                      }} style={{ aspectRatio: "1", borderRadius: 8, overflow: "hidden", border: "2px solid rgba(255,255,255,0.06)", cursor: "pointer" }}>
                        <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      </div>
                    ))}
                  </div>
                  <button onClick={() => setImagenStep(1)} style={{ marginTop: 16, fontSize: 11, color: "#4a5568", background: "none", border: "none", cursor: "pointer" }}>← Back</button>
                </div>
              )}

              {imagenStep === 3 && (
                <div>
                  {imagenSelected?.src && (
                    <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 16 }}>
                      <img src={imagenSelected.src} alt="selected" style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 8, border: "1px solid rgba(99,102,241,0.3)" }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 11, color: "#34d399", fontWeight: 700 }}>✓ Image selected</div>
                        <div style={{ fontSize: 10, color: "#4a5568", marginTop: 4 }}>This product will appear in your generated scene</div>
                      </div>
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: "#7e92a8", marginBottom: 8 }}>Describe the scene or environment <span style={{ color: "#4a5568" }}>(optional — or pick a template below)</span></div>

                  {/* ── Prompt templates ───────────────────────────────── */}
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: "#4a5568", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Quick templates</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {[
                        { label: "🌿 Garden / Outdoor", text: "in a natural Scandinavian garden setting with a well-maintained lawn, wooden decking and soft daylight" },
                        { label: "🛋️ Living Room", text: "in a bright minimalist Scandinavian living room with oak floors, large windows and soft natural light" },
                        { label: "🍳 Kitchen", text: "in a modern Scandinavian kitchen with marble countertops, clean white surfaces and warm ambient lighting" },
                        { label: "🏪 Retail / Store", text: "displayed in a clean modern retail environment with professional studio lighting and a neutral background" },
                        { label: "🌲 Nature / Forest", text: "in a natural forest or woodland setting with dappled sunlight filtering through the trees" },
                        { label: "🏙️ Urban / City", text: "in a modern urban setting on a clean city street with contemporary architecture in the background" },
                        { label: "⚡ In Action", text: "shown in action performing its primary task, dynamic angle, natural environment, motion implied" },
                        { label: "📸 Studio", text: "on a clean white studio background with soft professional lighting and subtle shadow, product centred" },
                      ].map(t => (
                        <button key={t.label} onClick={() => setImagenStylePrompt(t.text)} style={{
                          padding: "5px 10px", fontSize: 10, fontWeight: 600, borderRadius: 20,
                          cursor: "pointer", transition: "all 0.15s",
                          background: imagenStylePrompt === t.text ? "linear-gradient(135deg,rgba(99,102,241,0.4),rgba(14,165,233,0.4))" : "rgba(255,255,255,0.05)",
                          color: imagenStylePrompt === t.text ? "#a5b4fc" : "#4a5568",
                          border: imagenStylePrompt === t.text ? "1px solid rgba(99,102,241,0.5)" : "1px solid rgba(255,255,255,0.07)",
                        }}>{t.label}</button>
                      ))}
                    </div>
                  </div>

                  <textarea value={imagenStylePrompt} onChange={e => setImagenStylePrompt(e.target.value)}
                    placeholder="e.g. This is a Worx Robot Lawn Mower. Please insert it into a Danish garden setting on a well-maintained lawn on a sunny summer day"
                    rows={3} style={{ width: "100%", padding: "10px 12px", borderRadius: 8, fontSize: 12, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", color: "#e2e8f0", outline: "none", resize: "vertical", fontFamily: "inherit", boxSizing: "border-box" }}
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                    <button onClick={() => setImagenStep(imagenTab === 'upload' ? 1 : 2)} style={{ flex: 1, padding: "10px 0", fontSize: 12, fontWeight: 700, borderRadius: 8, background: "rgba(255,255,255,0.04)", color: "#7e92a8", border: "1px solid rgba(255,255,255,0.08)", cursor: "pointer" }}>← Back</button>
                    <button onClick={() => {
                      if (imagenSelected?.base64 || imagenSelected?.src) {
                        setImagenPreview(imagenSelected.src || imagenSelected.base64);
                        setImagenStep(4);
                      }
                    }} disabled={!imagenSelected?.src && !imagenSelected?.base64} style={{
                      flex: 1, padding: "10px 0", fontSize: 11, fontWeight: 700, borderRadius: 8,
                      background: "rgba(52,211,153,0.12)", color: "#34d399",
                      border: "1px solid rgba(52,211,153,0.3)",
                      cursor: (!imagenSelected?.src && !imagenSelected?.base64) ? "not-allowed" : "pointer",
                      opacity: (!imagenSelected?.src && !imagenSelected?.base64) ? 0.5 : 1,
                    }}>⬆ Use as-is</button>
                    <button onClick={async () => {
                      setImagenGenerating(true); setImagenError('');
                      try {
                        const productDesc = metaResult?.headlines?.[0] || 'product';
                        const scene = imagenStylePrompt.trim() || 'in a natural lifestyle setting with soft professional lighting';
                        const hasRef = !!(imagenSelected?.base64 || imagenSelected?.imageUrl);
                        const fullPrompt = hasRef
                          ? `This is a ${productDesc}. Please insert this exact product into the following scene: ${scene}. Keep the product clearly visible, true to its original shape, colour and design — do not alter the product appearance. Show the full product, not cropped. Photorealistic commercial photography, no text, no people, no logos.`
                          : `Professional advertising photograph of ${productDesc} ${scene}. Photorealistic, high-end commercial photography, full product visible, no people, no text, no logos.`;
                        const body = { prompt: fullPrompt };
                        if (imagenSelected?.base64) {
                          body.imageBase64 = imagenSelected.base64;
                          body.imageMimeType = imagenSelected.mimeType;
                        } else if (imagenSelected?.imageUrl) {
                          body.imageUrl = imagenSelected.imageUrl;
                        }
                        const r = await fetch('/api/imagen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                        const d = await r.json();
                        if (d.imageUrl) {
                          setImagenPreview(d.imageUrl); setImagenStep(4);
                          // Increment usage counter for non-pro users
                          if (!isPro && isSignedIn) {
                            fetch('/api/usage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: user.id, feature: 'imagen', action: 'increment', plan }) }).catch(()=>{});
                          }
                        }
                        else setImagenError(d.error || 'Generation failed');
                      } catch(e) { setImagenError(e.message || 'Generation failed'); }
                      setImagenGenerating(false);
                    }} style={{ flex: 2, padding: "10px 0", fontSize: 12, fontWeight: 700, borderRadius: 8, background: imagenGenerating ? "rgba(99,102,241,0.2)" : "linear-gradient(135deg,#6366f1,#0ea5e9)", color: "white", border: "none", cursor: imagenGenerating ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                      {imagenGenerating ? <><span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>✦</span> Generating...</> : "✦ Generate with Imagen"}
                    </button>
                  </div>
                  {imagenError && <div style={{ fontSize: 11, color: "#f87171", marginTop: 10 }}>{imagenError}</div>}
                </div>
              )}

              {imagenStep === 4 && (
                <div>
                  <div style={{ fontSize: 11, color: "#7e92a8", marginBottom: 12 }}>Your generated image — confirm to replace the Meta ad preview:</div>
                  <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 10, color: "#4a5568", marginBottom: 6, textAlign: "center" }}>Current</div>
                      <img src={metaResult?.imageUrl} alt="current" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 10, border: "1px solid rgba(255,255,255,0.08)" }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 10, color: "#34d399", fontWeight: 700, marginBottom: 6, textAlign: "center" }}>✦ New</div>
                      <img src={imagenPreview} alt="generated" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 10, border: "1px solid rgba(99,102,241,0.4)" }} />
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => setImagenStep(3)} style={{ flex: 1, padding: "10px 0", fontSize: 12, fontWeight: 700, borderRadius: 8, background: "rgba(255,255,255,0.04)", color: "#7e92a8", border: "1px solid rgba(255,255,255,0.08)", cursor: "pointer" }}>← Regenerate</button>
                    <button onClick={() => { setMetaResult(prev => ({ ...prev, imageUrl: imagenPreview })); setImagenOpen(false); }} style={{ flex: 2, padding: "10px 0", fontSize: 12, fontWeight: 700, borderRadius: 8, background: "linear-gradient(135deg,#059669,#10b981)", color: "white", border: "none", cursor: "pointer" }}>✓ Use this image</button>
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>
      )}

      {/* ── TikTok Tab ── */}
      {adFormat === 'tiktok' && generated && (
        <div id="tiktok-section" style={{ maxWidth: 900, margin: '0 auto', padding: '16px 24px' }}>
          {tiktokLoading && (
            <div style={{ textAlign: 'center', padding: '48px 0' }}>
              <div style={{ fontSize: 32, animation: 'spin 1.5s linear infinite', display: 'inline-block', marginBottom: 12 }}>♪</div>
              <div style={{ fontSize: 12, color: '#4a5568' }}>Generating TikTok ads…</div>
            </div>
          )}
          {tiktokError && (
            <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '12px 16px', color: '#fca5a5', fontSize: 12, marginBottom: 12 }}>
              {tiktokError}
            </div>
          )}
          {!tiktokLoading && !tiktokResult && !tiktokError && (
            <div style={{ textAlign: 'center', padding: '48px 0', color: '#4a5568' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>♪</div>
              <div style={{ fontSize: 13, marginBottom: 8 }}>TikTok ads not generated yet</div>
              <div style={{ fontSize: 11 }}>Check "Also generate TikTok ads" and click Generate</div>
            </div>
          )}
          {tiktokResult && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Hook + Copy */}
              <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '16px 20px' }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: '#ff4d4d', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>
                  ♪ TikTok In-Feed Ad Copy
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 10, color: '#4a5568', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Hook Line (first 3 seconds)</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: '#fca5a5', lineHeight: 1.3 }}>{tiktokResult.hookLine}</div>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 10, color: '#4a5568', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Primary Text</div>
                  <div style={{ fontSize: 14, color: '#e2e8f0', lineHeight: 1.5 }}>{tiktokResult.primaryText}</div>
                </div>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 10, color: '#4a5568', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>CTA</div>
                    <div style={{ fontSize: 13, color: '#34d399', fontWeight: 700 }}>{tiktokResult.cta}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: '#4a5568', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Hashtags</div>
                    <div style={{ fontSize: 12, color: '#818cf8' }}>{(tiktokResult.hashtags || []).join(' ')}</div>
                  </div>
                </div>
                <button onClick={() => {
                  const text = `${tiktokResult.hookLine}\n\n${tiktokResult.primaryText}\n\n${tiktokResult.cta}\n\n${(tiktokResult.hashtags || []).join(' ')}`;
                  navigator.clipboard.writeText(text);
                }} style={{ marginTop: 12, padding: '6px 14px', fontSize: 10, fontWeight: 700, background: 'rgba(255,77,77,0.15)', color: '#fca5a5', border: '1px solid rgba(255,77,77,0.3)', borderRadius: 6, cursor: 'pointer' }}>
                  Copy Ad Copy
                </button>
                {/* TikTok full export button */}
                <button onClick={() => {
                  const storyboardText = (tiktokResult.storyboard || []).map((s, i) =>
                    `Scene ${i+1} (${s.timing}) — ${s.title}\n${s.description}`
                  ).join('\n\n');
                  const exportText = [
                    '=== TIKTOK AD COPY ===',
                    '',
                    `HOOK: ${tiktokResult.hookLine || ''}`,
                    '',
                    `PRIMARY TEXT: ${tiktokResult.primaryText || ''}`,
                    '',
                    `CTA: ${tiktokResult.cta || ''}`,
                    '',
                    `HASHTAGS: ${(tiktokResult.hashtags || []).join(' ')}`,
                    '',
                    '=== VIDEO STORYBOARD ===',
                    '',
                    storyboardText,
                    '',
                    '=== VIDEO PROMPT ===',
                    '',
                    tiktokResult.videoPrompt || '',
                  ].join('\n');
                  navigator.clipboard.writeText(exportText);
                  setTiktokExportCopied(true);
                  setTimeout(() => setTiktokExportCopied(false), 3000);
                }} style={{ marginTop: 8, padding: '6px 14px', fontSize: 10, fontWeight: 700, background: tiktokExportCopied ? 'rgba(52,211,153,0.15)' : 'rgba(129,140,248,0.1)', border: tiktokExportCopied ? '1px solid rgba(52,211,153,0.4)' : '1px solid rgba(129,140,248,0.25)', borderRadius: 6, color: tiktokExportCopied ? '#34d399' : '#818cf8', cursor: 'pointer', width: '100%', transition: 'all 0.3s' }}>
                  {tiktokExportCopied ? '✓ Copied — ready for TikTok Ads Manager' : '📋 Copy Full TikTok Export'}
                </button>
              </div>

              {/* ── Branding & Overlay Panel ── */}
              {tiktokResult && (
                <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '14px 16px', marginBottom: 12 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: '#7e92a8', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>🎨 Branding & Overlays</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {/* Logo toggle */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <button onClick={() => setOverlayLogo(v => !v)} style={{ width: 32, height: 18, borderRadius: 9, background: overlayLogo ? '#6366f1' : 'rgba(255,255,255,0.1)', border: 'none', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                        <span style={{ position: 'absolute', top: 2, left: overlayLogo ? 16 : 2, width: 14, height: 14, borderRadius: '50%', background: 'white', transition: 'left 0.2s' }} />
                      </button>
                      <span style={{ fontSize: 11, color: '#94a3b8' }}>Include brand name in video</span>
                    </div>
                    {/* Intro headline */}
                    <div>
                      <div style={{ fontSize: 10, color: '#4a5568', marginBottom: 4 }}>Intro headline (optional)</div>
                      <input value={overlayIntro} onChange={e => setOverlayIntro(e.target.value)} placeholder="e.g. New arrival 🔥" style={{ width: '100%', padding: '6px 10px', fontSize: 11, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 6, color: '#e2e8f0', outline: 'none' }} maxLength={60} />
                    </div>
                    {/* Outro / exit message */}
                    <div>
                      <div style={{ fontSize: 10, color: '#4a5568', marginBottom: 4 }}>Exit message / CTA (optional)</div>
                      <input value={overlayOutro} onChange={e => setOverlayOutro(e.target.value)} placeholder="e.g. Shop now at sunset-boulevard.dk" style={{ width: '100%', padding: '6px 10px', fontSize: 11, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 6, color: '#e2e8f0', outline: 'none' }} maxLength={80} />
                    </div>
                  </div>
                </div>
              )}

              {/* Video Storyboard */}
              <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '16px 20px' }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: '#818cf8', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>
                  🎬 Video Storyboard (9:16)
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {(tiktokResult.storyboard || []).map((scene, i) => (
                    <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 12px', background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.05)' }}>
                      <div style={{ flexShrink: 0, width: 48, height: 48, borderRadius: 8, background: 'linear-gradient(135deg,#ff0050,#ff4d4d)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
                        <div style={{ fontSize: 14, fontWeight: 900, color: 'white' }}>{scene.scene}</div>
                        <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.7)' }}>{scene.timing}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#a5b4fc', marginBottom: 3 }}>{scene.title}</div>
                        <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.5 }}>{scene.description}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Video Generation */}
              <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '16px 20px' }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: '#34d399', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 12 }}>
                  🎬 Generate Video (Kling AI)
                </div>
                {tiktokVideoUrl ? (
                  <div>
                    <video src={tiktokVideoUrl} controls style={{ width: '100%', maxWidth: 280, borderRadius: 8, aspectRatio: '9/16' }} />
{/* ENHANCE PANEL — hidden, restore by removing {false &&} wrapper */}
                    {false && (
                    <>                    {/* ── Enhance with branding ── */}
                    <div style={{ marginTop: 12, padding: '12px 14px', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: enhanceOpen ? 12 : 0 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: '#a5b4fc' }}>🎨 Enhance with branding</div>
                        <button onClick={() => {
                          setEnhanceOpen(v => !v);
                          if (!enhanceOpen) {
                            setEnhanceIntro(overlayIntro || '');
                            setEnhanceOutro(overlayOutro || tiktokResult?.cta || '');
                          }
                        }} style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 5, border: '1px solid rgba(99,102,241,0.3)', background: enhanceOpen ? 'rgba(99,102,241,0.2)' : 'transparent', color: '#a5b4fc', cursor: 'pointer' }}>
                          {enhanceOpen ? 'Close' : 'Open'}
                        </button>
                      </div>
                      {enhanceOpen && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div style={{ fontSize: 10, color: '#4a5568', lineHeight: 1.5 }}>
                            Add your own text overlays and brand identity to the video. The branded version will be downloaded as an MP4.
                          </div>
                          <div>
                            <div style={{ fontSize: 10, color: '#4a5568', marginBottom: 3 }}>Intro text (shown at start)</div>
                            <input value={enhanceIntro} onChange={e => setEnhanceIntro(e.target.value)}
                              placeholder="e.g. New collection 🔥" maxLength={50}
                              style={{ width: '100%', padding: '5px 8px', fontSize: 10, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 5, color: '#e2e8f0', outline: 'none' }} />
                          </div>
                          <div>
                            <div style={{ fontSize: 10, color: '#4a5568', marginBottom: 3 }}>Outro/CTA text (shown at end)</div>
                            <input value={enhanceOutro} onChange={e => setEnhanceOutro(e.target.value)}
                              placeholder="e.g. Shop now at mysite.dk" maxLength={60}
                              style={{ width: '100%', padding: '5px 8px', fontSize: 10, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 5, color: '#e2e8f0', outline: 'none' }} />
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <button onClick={() => setEnhanceBrand(v => !v)} style={{ width: 28, height: 16, borderRadius: 8, background: enhanceBrand ? '#6366f1' : 'rgba(255,255,255,0.1)', border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0 }}>
                              <span style={{ position: 'absolute', top: 2, left: enhanceBrand ? 14 : 2, width: 12, height: 12, borderRadius: '50%', background: 'white', transition: 'left 0.15s' }} />
                            </button>
                            <span style={{ fontSize: 10, color: '#94a3b8' }}>Show brand name: {tiktokResult?.brand || ''}</span>
                          </div>
                          {/* Live canvas preview */}
                          <div style={{ marginTop: 4 }}>
                            <div style={{ fontSize: 10, color: '#4a5568', marginBottom: 4 }}>Preview overlay card:</div>
                            <canvas ref={el => {
                              if (!el) return;
                              const w = el.width, h = el.height;
                              const ctx = el.getContext('2d');
                              // Dark gradient background
                              const grad = ctx.createLinearGradient(0, 0, 0, h);
                              grad.addColorStop(0, '#0f172a');
                              grad.addColorStop(1, '#1e293b');
                              ctx.fillStyle = grad;
                              ctx.fillRect(0, 0, w, h);
                              // Center label
                              ctx.fillStyle = 'rgba(255,255,255,0.1)';
                              ctx.font = `${Math.round(w*0.06)}px Arial`;
                              ctx.textAlign = 'center';
                              ctx.fillText('▶ video', w/2, h/2);
                              // Intro text
                              if (enhanceIntro) {
                                ctx.fillStyle = 'rgba(0,0,0,0.65)';
                                ctx.fillRect(0, h*0.04, w, h*0.13);
                                ctx.fillStyle = 'white';
                                ctx.font = `bold ${Math.round(w*0.07)}px Arial`;
                                ctx.textAlign = 'center';
                                ctx.fillText(enhanceIntro.slice(0,30), w/2, h*0.125);
                              }
                              // Outro text
                              if (enhanceOutro) {
                                ctx.fillStyle = 'rgba(0,0,0,0.7)';
                                ctx.fillRect(0, h*0.82, w, h*0.13);
                                ctx.fillStyle = 'white';
                                ctx.font = `bold ${Math.round(w*0.062)}px Arial`;
                                ctx.textAlign = 'center';
                                ctx.fillText(enhanceOutro.slice(0,35), w/2, h*0.9);
                              }
                              // Brand name
                              if (enhanceBrand && tiktokResult?.brand) {
                                ctx.font = `bold ${Math.round(w*0.05)}px Arial`;
                                ctx.textAlign = 'right';
                                ctx.fillStyle = 'rgba(255,255,255,0.8)';
                                ctx.fillText(tiktokResult.brand, w-w*0.04, h-h*0.025);
                              }
                            }} width={160} height={285} style={{ width: '100%', borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)' }} />
                          </div>
                          <button onClick={() => {
                            const canvas = document.querySelector('canvas[width="160"]');
                            if (!canvas) return;
                            const link = document.createElement('a');
                            link.download = `${tiktokResult?.brand || 'tiktok'}-overlay-card.png`;
                            link.href = canvas.toDataURL('image/png');
                            link.click();
                          }} style={{ width: '100%', padding: '7px', fontSize: 10, fontWeight: 700, background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', marginTop: 4 }}>
                            📸 Download Overlay Card
                          </button>
                          <div style={{ fontSize: 9, color: '#4a5568', textAlign: 'center' }}>
                            Downloads a branded overlay card to use alongside your video
                          </div>
                        </div>
                      )}
                    </div>
</>
                    )}                  </div>
                ) : tiktokVideoLoading ? (
                  <div style={{ width: '100%', maxWidth: 280, aspectRatio: '9/16', borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                    <span style={{ fontSize: 32, animation: 'spin 2s linear infinite', display: 'inline-block' }}>🎬</span>
                    <div style={{ fontSize: 11, color: '#4a5568', textAlign: 'center', padding: '0 16px' }}>Generating your TikTok video…<br/>Check back in 3–4 minutes</div>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 11, color: '#4a5568', marginBottom: 10, lineHeight: 1.5 }}>
                      {tiktokResult.videoPrompt}
                    </div>
                    <button onClick={async () => {
                      if (!tiktokResult.videoPrompt) return;
                      setTiktokVideoLoading(true);
                      try {
                        // Use explicitly selected thumbnail (persisted through Meta regen) or fall back to active variant
                        const selectedImg = tiktokSourceImageRef.current || metaResult?.imageVariations?.[activeImageVariant] || metaResult?.imageUrl || metaResult?.heroProductImage || null;
                        const imageUrl = selectedImg;
                        if (!imageUrl) { alert('Generate a Meta ad first to get a product image for the video'); setTiktokVideoLoading(false); return; }
                        // Submit to Kling via fal.ai — pass full storyboard for multi-scene video
                        // Route to Runway or Kling — use ref to avoid stale closure
                        const currentEngine = videoEngineRef.current;
                        const videoApi = currentEngine === 'runway' ? '/api/runway' : '/api/kling';
                        const videoPayload = currentEngine === 'runway'
                          ? { imageUrl, prompt: tiktokResult.videoPrompt, duration: 10, language: pageMeta?.language || 'English', brand: overlayLogo ? (tiktokResult.brand || pageMeta?.brand || '') : '', overlayIntro: overlayIntro || '', overlayOutro: overlayOutro || tiktokResult.cta || '' }
                          : { imageUrl, storyboard: tiktokResult.storyboard, prompt: tiktokResult.videoPrompt, language: pageMeta?.language || 'English', brand: overlayLogo ? (tiktokResult.brand || pageMeta?.brand || '') : '', logoUrl: overlayLogo ? pmaxLogo : null, overlayIntro: overlayIntro || '', overlayOutro: overlayOutro || tiktokResult.cta || '' };
                        const r = await fetch(videoApi, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(videoPayload),
                        });
                        const d = await r.json();
                        if (d.videoUrl) { setTiktokVideoUrl(d.videoUrl); setTiktokVideoLoading(false); }
                        else if (d.requestId || d.taskId) {
                          // Poll for completion — handle both Kling (requestId) and Runway (taskId)
                          const pollId = d.requestId || d.taskId;
                          const pollKey = d.taskId ? 'taskId' : 'requestId';
                          let attempts = 0;
                          const poll = setInterval(async () => {
                            if (attempts++ > 60) { setTiktokVideoLoading(false); clearInterval(poll); return; }
                            const pr = await fetch(videoApi, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'poll', [pollKey]: pollId }) });
                            const pd = await pr.json();
                            if (pd.videoUrl) { setTiktokVideoUrl(pd.videoUrl); setTiktokVideoLoading(false); clearInterval(poll); }
                            else if (pd.status === 'FAILED') { setTiktokVideoLoading(false); clearInterval(poll); }
                          }, 5000);
                        } else { setTiktokVideoLoading(false); }
                      } catch(e) { setTiktokVideoLoading(false); }
                    }} disabled={tiktokVideoLoading} style={{
                      padding: '8px 16px', fontSize: 11, fontWeight: 700,
                      background: tiktokVideoLoading ? 'rgba(52,211,153,0.1)' : 'linear-gradient(135deg,#34d399,#059669)',
                      color: tiktokVideoLoading ? '#34d399' : 'white', border: 'none', borderRadius: 8, cursor: tiktokVideoLoading ? 'not-allowed' : 'pointer',
                      display: 'flex', alignItems: 'center', gap: 6,
                      animation: tiktokVideoLoading ? 'pulse 1.5s ease-in-out infinite' : 'none',
                    }}>
                      {tiktokVideoLoading ? <><span style={{ animation: 'spin 0.8s linear infinite', display: 'inline-block' }}>⟳</span> Generating with {videoEngine === 'runway' ? 'Runway' : 'Kling'}…</> : (videoEngine === 'runway' ? '🎞 Generate Video (Runway)' : '🎬 Generate Video (Kling V3)')}
                    </button>
                  </>
                )}

                {/* ── UGC Avatar Video (HeyGen) ── */}
                {/* ── Video Engine Selector ── */}
                {tiktokResult && (
                  <div style={{ marginBottom: 12, padding: '12px 14px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8 }}>
                    <div style={{ fontSize: 10, color: '#4a5568', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                      🎬 Video engine
                      {videoEngine === 'runway' && <span style={{ color: '#fbbf24', fontWeight: 700 }}>★ Runway recommended</span>}
                      {videoEngine === 'kling' && <span style={{ color: '#34d399', fontWeight: 700 }}>★ Kling AI recommended</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {[
                        { id: 'kling', label: '⚡ Kling V3', desc: 'Products & food', color: '#34d399' },
                        { id: 'runway', label: '🎞 Runway', desc: 'Fashion & models', color: '#fbbf24' },
                      ].map(e => (
                        <button key={e.id} onClick={() => setVideoEngine(e.id)} style={{
                          flex: 1, padding: '7px 10px', fontSize: 10, fontWeight: 700, borderRadius: 7,
                          background: videoEngine === e.id ? (e.id === 'kling' ? 'rgba(52,211,153,0.12)' : 'rgba(251,191,36,0.12)') : 'rgba(255,255,255,0.04)',
                          color: videoEngine === e.id ? e.color : '#7e92a8',
                          border: videoEngine === e.id ? `1px solid ${e.color}40` : '1px solid rgba(255,255,255,0.08)',
                          cursor: 'pointer', transition: 'all 0.15s',
                        }}>
                          <div>{e.label}</div>
                          <div style={{ fontSize: 9, opacity: 0.7, fontWeight: 400, marginTop: 2 }}>{e.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {tiktokResult && (
                  <div style={{ marginTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 16 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: '#7e92a8', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>🎭 UGC Creator</div>
                    {/* Scene variant selector */}
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 10, color: '#4a5568', marginBottom: 6 }}>Scene style:</div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {[
                          { id: 'talking', label: '🎤 Talking Head' },
                          { id: 'product', label: '📦 Product Demo' },
                          { id: 'friends', label: '👥 Social Setting' },
                        ].map(s => (
                          <button key={s.id} onClick={() => setUgcScene(s.id)} style={{
                            padding: '5px 10px', fontSize: 10, fontWeight: 700, borderRadius: 6,
                            background: ugcScene === s.id ? 'rgba(168,85,247,0.25)' : 'rgba(255,255,255,0.04)',
                            color: ugcScene === s.id ? '#d8b4fe' : '#7e92a8',
                            border: ugcScene === s.id ? '1px solid rgba(168,85,247,0.4)' : '1px solid rgba(255,255,255,0.08)',
                            cursor: 'pointer', transition: 'all 0.15s', flexShrink: 0,
                          }}>{s.label}</button>
                        ))}
                      </div>
                    </div>
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 10, color: '#4a5568', marginBottom: 6 }}>Avatar voice:</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {[
                          { id: 'Ivy', label: '👩 Ivy' },
                          { id: 'Brenda - UGC - 1.mp4', label: '🎬 Brenda' },
                          { id: 'George UGC 1', label: '🧔 George' },
                          { id: 'Rose - UGC - 1.mp4', label: '🌹 Rose' },
                        ].map(av => (
                          <button key={av.id} onClick={() => setUgcAvatar(av.id)} style={{
                            padding: '5px 10px', fontSize: 10, fontWeight: 700, borderRadius: 6,
                            background: ugcAvatar === av.id ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.04)',
                            color: ugcAvatar === av.id ? '#a5b4fc' : '#7e92a8',
                            border: ugcAvatar === av.id ? '1px solid rgba(99,102,241,0.4)' : '1px solid rgba(255,255,255,0.08)',
                            cursor: 'pointer', transition: 'all 0.15s',
                          }}>{av.label}</button>
                        ))}
                      </div>
                    </div>
                    <button onClick={async () => {
                      if (!tiktokResult?.hookLine) return;
                      setUgcLoading(true); setUgcVideoUrl(null);
                      try {
                        // Build script with optional intro/outro overlays
                        const introText = overlayIntro ? `${overlayIntro}. ` : '';
                        const outroText = overlayOutro || tiktokResult.cta || '';
                        const brandText = overlayLogo && (tiktokResult.brand || pageMeta?.brand) ? ` — ${tiktokResult.brand || pageMeta?.brand}` : '';
                        const script = `${introText}${tiktokResult.hookLine} ${tiktokResult.primaryText || ''} ${outroText}${brandText}`.trim().slice(0, 400);
                        // Scene motion prompts
                        const sceneMotion = ugcScene === 'product'
                          ? 'holding up and showcasing a product with both hands, gesturing towards it enthusiastically, demonstrating it to the camera'
                          : ugcScene === 'friends'
                          ? 'casual relaxed setting, natural gestures, talking to friends off-camera, occasional laughter, authentic social media vibe'
                          : 'direct to camera talking head, natural expressions, occasional nods and hand gestures';
                        const avatarImg = 'https://v3b.fal.media/files/b/0a90062c/A7EIviZqNxZ2HAs0yHeZ6_77a05b99-8588-4ffc-90aa-be7f9d34e9d3.png';
                        const r = await fetch('/api/heygen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageUrl: avatarImg, script, voiceId: ugcAvatar, motionPrompt: sceneMotion }) });
                        const d = await r.json();
                        if (d.videoUrl) { setUgcVideoUrl(d.videoUrl); setUgcLoading(false); }
                        else if (d.requestId) {
                          let attempts = 0;
                          const poll = setInterval(async () => {
                            if (attempts++ > 60) { setUgcLoading(false); clearInterval(poll); return; }
                            const pr = await fetch('/api/heygen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'poll', requestId: d.requestId, imageUrl: avatarImg, script: d.script || script, voiceId: d.voiceId || ugcAvatar }) });
                            const pd = await pr.json();
                            if (pd.videoUrl) { setUgcVideoUrl(pd.videoUrl); setUgcLoading(false); clearInterval(poll); }
                            else if (pd.status === 'FAILED') { setUgcLoading(false); clearInterval(poll); }
                          }, 5000);
                        } else { setUgcLoading(false); }
                      } catch(e) { setUgcLoading(false); }
                    }} disabled={ugcLoading} style={{
                      width: '100%', padding: '8px 16px', fontSize: 11, fontWeight: 700,
                      background: ugcLoading ? 'rgba(168,85,247,0.1)' : 'linear-gradient(135deg, #7c3aed, #a855f7)',
                      color: ugcLoading ? '#a855f7' : 'white', border: 'none', borderRadius: 8,
                      cursor: ugcLoading ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      animation: ugcLoading ? 'pulse 1.5s ease-in-out infinite' : 'none',
                    }}>
                      {ugcLoading ? <><span style={{ animation: 'spin 0.8s linear infinite', display: 'inline-block' }}>⟳</span> Generating UGC…</> : '🎭 Generate UGC Creator Video'}
                    </button>
                    {ugcLoading && <div style={{ marginTop: 8, fontSize: 10, color: '#4a5568' }}>⏱ Avatar video takes <span style={{ color: '#e2e8f0', fontWeight: 700 }}>1–2 minutes</span>.</div>}
                    {ugcVideoUrl && <video src={ugcVideoUrl} controls style={{ width: '100%', maxWidth: 280, borderRadius: 8, aspectRatio: '9/16', marginTop: 12 }} />}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
