// ── Constants ────────────────────────────────────────────────────────────────
const FREE_LIMIT = 10;        // generations allowed before gate
const WINDOW_DAYS = 30;       // rolling window in days
const WINDOW_SECS = WINDOW_DAYS * 24 * 60 * 60;

// ── Upstash Redis helper (REST API — no npm package needed) ──────────────────
async function redis(command, ...args) {
  const url  = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;   // Redis not configured — fail open
  const res = await fetch(`${url}/${[command, ...args].map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.result;
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "API key not configured" });

  // ── IP-based usage gate ───────────────────────────────────────────────────
  // Get the real client IP (Vercel sets x-forwarded-for)
  const ip = (req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  const redisKey = `rsa:ip:${ip}`;

  try {
    // Check current count
    const current = await redis("GET", redisKey);
    const count = parseInt(current || "0", 10);

    if (count >= FREE_LIMIT) {
      // Return a specific gated status — do NOT call Anthropic
      return res.status(200).json({
        gated: true,
        count,
        limit: FREE_LIMIT,
        message: `You've used all ${FREE_LIMIT} free generations. Create a free account to continue.`,
      });
    }

    // ── Call Anthropic ────────────────────────────────────────────────────────
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    console.log("Anthropic status:", response.status);
    if (!response.ok) {
      console.log("Anthropic error:", JSON.stringify(data).slice(0, 300));
      return res.status(response.status).json(data);
    }

    // ── Increment counter only on success ─────────────────────────────────────
    const newCount = count + 1;
    if (current === null || current === undefined) {
      // First use — set with expiry window
      await redis("SET", redisKey, newCount, "EX", WINDOW_SECS);
    } else {
      // Increment and preserve existing TTL
      await redis("INCR", redisKey);
    }

    // Return response with usage info attached
    return res.status(200).json({
      ...data,
      usage_count: newCount,
      usage_limit: FREE_LIMIT,
      gated: false,
    });

  } catch (err) {
    // If Redis fails for any reason — fail open (don't block the user)
    console.log("Gate error (failing open):", err.message);
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(req.body),
      });
      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (e) {
      return res.status(500).json({ error: "Proxy error: " + e.message });
    }
  }
}
