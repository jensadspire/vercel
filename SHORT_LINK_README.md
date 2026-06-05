# Short-Link System — Integration Notes

## What was built

Three files providing a self-hosted, first-party URL shortener for outreach emails:

```
lib/slugify.js              ← reusable token generation utility
api/short-link.js           ← POST endpoint: create a short link (called by send-outreach.js)
api/r/[token].js            ← GET endpoint: handle redirect + log click + append UTM
```

## How it works

1. `send-outreach.js` POSTs each prospect's destination URL + product name to `/api/short-link`
2. The endpoint generates a token like `small-love-selection-box-2026-05-da` and stores the destination + UTM + recipient metadata in Upstash (90-day TTL)
3. The email contains `theaiad.studio/r/{token}` — clean, readable, ≤60 chars
4. When the prospect clicks, `/r/[token]` looks up the record, logs the click, appends UTM params to the destination, and redirects 302

## Required env vars (Vercel)

Already in your env:
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

New ones to add:
- `INTERNAL_API_TOKEN` — random secret, prevents random POSTs from creating links. Generate with `openssl rand -hex 32`. Used as `x-internal-token` header from `send-outreach.js`.
- `PUBLIC_BASE_URL` — optional; defaults to `https://www.theaiad.studio` if absent
- `SHORT_LINK_LOG_CLICKS` — optional; set to `"true"` to write per-click events to Upstash for richer analytics (uses more keys; off by default)

## Required dependency

```bash
npm install @upstash/redis
```

(May already be installed if you're using Upstash from other API routes. Check `package.json` first.)

## Integration into send-outreach.js

Replace the existing `buildLinks()` function. Pseudocode for the new shape:

```js
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
const BASE_URL           = process.env.PUBLIC_BASE_URL || 'https://www.theaiad.studio';
const CAMPAIGN_CODE      = '2026-05-da';                    // adjust per send
const CAMPAIGN_ID        = `outreach_${CAMPAIGN_CODE.replace(/-/g, '_')}`; // e.g. outreach_2026_05_da

async function createShortLink({ productName, destination, recipientEmail }) {
  const response = await fetch(`${BASE_URL}/api/short-link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-token': INTERNAL_API_TOKEN,
    },
    body: JSON.stringify({
      product_name:    productName,
      campaign_code:   CAMPAIGN_CODE,
      destination,
      utm: { source: 'hs_email', medium: 'email', campaign: CAMPAIGN_ID },
      recipient_email: recipientEmail,
      campaign_id:     CAMPAIGN_ID,
    }),
  });
  if (!response.ok) throw new Error(`short-link API failed: ${response.status}`);
  const data = await response.json();
  return data.short_url; // e.g. "https://www.theaiad.studio/r/small-love-selection-box-2026-05-da"
}

const buildLinks = async (productUrl, productName, recipientEmail) => {
  const rsaDestination  = `${BASE_URL}/?url=${encodeURIComponent(productUrl)}&autorun=true`;
  const metaDestination = `${BASE_URL}/?url=${encodeURIComponent(productUrl)}&autorun=true&tab=meta`;

  const [rsa, meta] = await Promise.all([
    createShortLink({ productName: `${productName} (RSA)`,  destination: rsaDestination,  recipientEmail }),
    createShortLink({ productName: `${productName} (Meta)`, destination: metaDestination, recipientEmail }),
  ]);

  return { rsa, meta };
};
```

Two important notes:

1. **`buildLinks()` is now async.** Every call site needs to be updated to `await`. If `send-outreach.js` builds links inside a `.map()`, change it to `for...of` (sequential) or `Promise.all(...)` (parallel — faster for batch sends).

2. **The RSA vs Meta differentiation** — since both links point to the same product, they'd generate the same slug and collide. I appended " (RSA)" / " (Meta)" to the `productName` so they slug as different tokens: `small-love-selection-box-rsa-2026-05-da` and `small-love-selection-box-meta-2026-05-da`. Alternatively, pass them through with different `campaign_code` suffixes (`2026-05-da-rsa` vs `2026-05-da-meta`) — your call.

## Testing

Once deployed (preview deploy first, then production after Meta approval):

```bash
# Create a test link
curl -X POST https://www.theaiad.studio/api/short-link \
  -H "Content-Type: application/json" \
  -H "x-internal-token: $INTERNAL_API_TOKEN" \
  -d '{
    "product_name": "Test Product",
    "campaign_code": "2026-05-test",
    "destination": "https://www.theaiad.studio/?url=https%3A%2F%2Fexample.com",
    "utm": { "source": "hs_email", "medium": "email", "campaign": "test" },
    "recipient_email": "you@adspire.de",
    "campaign_id": "test"
  }'

# Then visit https://www.theaiad.studio/r/test-product-2026-05-test in a browser
# Should redirect to the destination with UTM params appended.
```

## Click stats — quick query

To check click counts across a campaign, run from any environment with the Upstash credentials:

```js
const { Redis } = require('@upstash/redis');
const redis = Redis.fromEnv();

const keys = await redis.keys('shortlink:*-2026-05-da');
const records = await Promise.all(keys.map(k => redis.get(k)));
const total = records.reduce((sum, r) => sum + (r?.clicks || 0), 0);
console.log(`Campaign 2026-05-da: ${records.length} links, ${total} total clicks`);
```

A small analytics dashboard endpoint is a Deploy 2 backlog candidate if useful.

## Safety re: Meta review

Adding new routes (`/api/short-link`, `/r/[token]`) is purely additive — does not modify any existing code path or any flow the Meta reviewer touches. Reviewer's flow goes through `/`, `/api/meta-*`, the privacy/terms pages — none of which are affected.

**Recommended deployment cadence:**
1. Build on a Vercel preview branch this week (during the Meta wait)
2. Test end-to-end via the preview URL
3. Merge to production *after* Meta approval lands

If you want to ship to production immediately, the technical risk is genuinely minimal — but the discipline of "no changes during review" is still worth following.
