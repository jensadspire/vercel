// /api/meta-accounts.js
// Returns the authenticated user's Meta ad accounts and Facebook pages so the
// frontend can show a picker. Reads the stored long-lived token from Upstash.

import { createClerkClient } from '@clerk/backend';
import { getMetaCredentials } from './lib/meta-token-store.js';

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY,
});
const GRAPH = 'https://graph.facebook.com/v21.0';

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
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const userId = await authenticateUser(req);
    const creds = await getMetaCredentials(userId);
    if (!creds?.accessToken) {
      return res.status(400).json({ error: 'Meta account not connected', needsConnect: true });
    }

    // Fetch ad accounts and pages in parallel
    const [adAccountsRes, pagesRes] = await Promise.all([
      fetch(`${GRAPH}/me/adaccounts?fields=id,name,account_id,currency,account_status,timezone_name&access_token=${creds.accessToken}`),
      fetch(`${GRAPH}/me/accounts?fields=id,name,access_token,category,tasks&limit=50&access_token=${creds.accessToken}`),
    ]);

    const adAccountsData = await adAccountsRes.json();
    const pagesData = await pagesRes.json();

    if (adAccountsData.error) {
      // Common case: token expired / scopes missing
      return res.status(401).json({
        error: 'Meta API rejected the request: ' + adAccountsData.error.message,
        code: adAccountsData.error.code,
        needsReconnect: adAccountsData.error.code === 190, // OAuthException
      });
    }

    // Filter ad accounts to only ACTIVE ones (account_status 1 = ACTIVE)
    const adAccounts = (adAccountsData.data || [])
      .filter(a => a.account_status === 1 || a.account_status === undefined)
      .map(a => ({
        id: a.id,                  // e.g. "act_1234567890"
        accountId: a.account_id,    // e.g. "1234567890"
        name: a.name,
        currency: a.currency,
        timezone: a.timezone_name,
      }));

    // Filter pages to only those where the user has CREATE_CONTENT or ADVERTISE permission
    // (a page without ADVERTISE permission cannot be used as the page_id on ads)
    const pages = (pagesData.data || [])
      .filter(p => !p.tasks || p.tasks.includes('CREATE_CONTENT') || p.tasks.includes('ADVERTISE'))
      .map(p => ({
        id: p.id,
        name: p.name,
        category: p.category,
      }));

    return res.status(200).json({
      success: true,
      adAccounts,
      pages,
      selected: {
        adAccountId: creds.adAccountId,
        pageId: creds.pageId,
      },
    });
  } catch (err) {
    console.error('[meta-accounts] error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
