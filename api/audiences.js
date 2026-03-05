// ── Audience Modifiers — persistent storage via Upstash Redis ─────────────────
async function redis(command, ...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/${[command, ...args].map(encodeURIComponent).join("/")}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data.result;
  } catch (_) { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { action, userId, audiences, optIn } = req.body;

  // ── Store marketing opt-in preference temporarily (no userId yet — pre-signup) ──
  if (action === "set-optin") {
    try {
      // Store with a short TTL (30 mins) — just long enough for Clerk signup to complete
      await redis("SET", "rsa:pending:optin", optIn ? "1" : "0", "EX", 1800);
      return res.status(200).json({ saved: true });
    } catch (_) {
      return res.status(200).json({ saved: false });
    }
  }

  // ── Get pending opt-in (called from clerk webhook) ────────────────────────
  if (action === "get-optin") {
    try {
      const val = await redis("GET", "rsa:pending:optin");
      return res.status(200).json({ optIn: val !== "0" }); // default true if not set
    } catch (_) {
      return res.status(200).json({ optIn: true });
    }
  }

  if (!userId) return res.status(400).json({ error: "userId required" });

  const key = `rsa:user:${userId}:audiences`;

  if (action === "get") {
    try {
      const stored = await redis("GET", key);
      const parsed = stored ? JSON.parse(stored) : [];
      return res.status(200).json({ audiences: parsed });
    } catch (_) {
      return res.status(200).json({ audiences: [] });
    }
  }

  if (action === "set") {
    try {
      await redis("SET", key, JSON.stringify(audiences || []));
      return res.status(200).json({ saved: true });
    } catch (_) {
      return res.status(200).json({ saved: false });
    }
  }

  return res.status(400).json({ error: "Invalid action" });
}
