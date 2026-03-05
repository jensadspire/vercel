// ── Clerk webhook handler ─────────────────────────────────────────────────────
// Receives user.created events from Clerk and forwards to Zapier → HubSpot
// Vercel env vars needed:
//   CLERK_WEBHOOK_SECRET  — from Clerk Dashboard → Developers → Webhooks → signing secret
//   ZAPIER_CLERK_WEBHOOK_URL — new Zapier webhook URL for completed sign-ups

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const payload = req.body;

    // Only process user.created events
    if (payload?.type !== "user.created") {
      return res.status(200).json({ received: true, skipped: true });
    }

    const { id, email_addresses, first_name, last_name, created_at } = payload.data;
    const primaryEmail = email_addresses?.find(e => e.id === payload.data.primary_email_address_id)?.email_address
      || email_addresses?.[0]?.email_address
      || null;

    if (!primaryEmail) {
      console.log("Clerk webhook: no email found in payload");
      return res.status(200).json({ received: true, skipped: true });
    }

    const zapierUrl = process.env.ZAPIER_CLERK_WEBHOOK_URL;
    if (!zapierUrl) {
      console.log("Clerk webhook: ZAPIER_CLERK_WEBHOOK_URL not configured");
      return res.status(200).json({ received: true, skipped: true });
    }

    // Read marketing opt-in directly from Redis
    let marketingOptIn = true; // default true
    try {
      const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
      const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (redisUrl && redisToken) {
        const optInRes = await fetch(`${redisUrl}/${encodeURIComponent("GET")}/${encodeURIComponent("rsa:pending:optin")}`, {
          headers: { Authorization: `Bearer ${redisToken}` },
        });
        const optInData = await optInRes.json();
        if (optInData.result === "0") marketingOptIn = false;
      }
    } catch (_) {}

    // Forward to Zapier
    await fetch(zapierUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: primaryEmail,
        first_name: first_name || "",
        last_name: last_name || "",
        full_name: [first_name, last_name].filter(Boolean).join(" ") || "",
        clerk_user_id: id,
        source: "RSA Studio — Free Account Sign-up",
        signup_timestamp: new Date(created_at).toISOString(),
        plan: "free",
        marketing_opt_in: marketingOptIn ? "Yes" : "No",
      }),
    });

    console.log("Clerk webhook: forwarded sign-up to Zapier for", primaryEmail);
    return res.status(200).json({ received: true, forwarded: true });

  } catch (err) {
    console.log("Clerk webhook error:", err.message);
    // Always return 200 to Clerk — otherwise it will retry
    return res.status(200).json({ received: true, error: err.message });
  }
}
