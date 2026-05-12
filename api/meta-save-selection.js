// /api/meta-save-selection.js
// Persists the user's chosen ad account + Facebook page to Upstash so future
// publishes know which account to use.

import { createClerkClient } from '@clerk/backend';
import { saveMetaSelection } from './lib/meta-token-store.js';

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

async function authenticateUser(req) {
  const sessionToken = req.headers.authorization?.replace(/^Bearer /, '')
    || req.headers['x-clerk-session'];
  if (!sessionToken) throw new Error('Missing Authorization or x-clerk-session header');
  const session = await clerkClient.authenticateRequest(
    new Request(`https://${req.headers.host}${req.url}`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    })
  );
  const auth = session.toAuth();
  if (!auth?.userId) throw new Error('Not signed in');
  return auth.userId;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const userId = await authenticateUser(req);
    const { adAccountId, pageId } = req.body || {};

    if (!adAccountId || !pageId) {
      return res.status(400).json({ error: 'adAccountId and pageId both required' });
    }

    // Sanity: ad account IDs should start with 'act_'
    const normalisedAdAccount = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;

    await saveMetaSelection({
      userId,
      adAccountId: normalisedAdAccount,
      pageId: String(pageId),
    });

    return res.status(200).json({
      success: true,
      adAccountId: normalisedAdAccount,
      pageId: String(pageId),
    });
  } catch (err) {
    console.error('[meta-save-selection] error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
