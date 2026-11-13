// /api/client-domains.js
// Phase 2 (agency onboarding): stores a client workspace's declared domain(s) on
// the Clerk organization's publicMetadata (which is backend-write-only). Called
// right after an agency creates a client workspace in the custom create flow, and
// later from the domains editor.
//
//   POST { orgId, domains }   — domains: string[] or comma/space-separated string
//   Auth: Bearer session token (same pattern as the other authenticated endpoints).
//   Guard: the caller must be a member of orgId (the creator is admin).
//   Domains are normalised server-side (host only — no protocol/www/path/port),
//   deduped, validated, and capped. The stored shape is org.publicMetadata.domains.

import { createClerkClient } from '@clerk/backend';

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.VITE_CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY,
});

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
  return { userId: auth.userId };
}

function normDomain(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  const p = s.indexOf('//'); if (p >= 0) s = s.slice(p + 2);   // strip scheme
  const at = s.indexOf('@'); if (at >= 0) s = s.slice(at + 1); // strip any accidental user@ prefix
  if (s.slice(0, 4) === 'www.') s = s.slice(4);                // strip www.
  const sl = s.indexOf('/'); if (sl >= 0) s = s.slice(0, sl);  // strip path
  const q = s.indexOf('?'); if (q >= 0) s = s.slice(0, q);     // strip query
  s = s.split(':')[0].trim();                                  // strip port
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return '';          // must look like a domain
  return s;
}

function normDomainList(input) {
  let arr = [];
  if (Array.isArray(input)) arr = input;
  else if (typeof input === 'string') arr = input.split(/[\s,;]+/);
  const out = [];
  for (const d of arr) {
    const n = normDomain(d);
    if (n && !out.includes(n)) out.push(n);
    if (out.length >= 8) break;
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { userId } = await authenticateUser(req);
    const { orgId, domains } = req.body || {};
    if (!orgId || typeof orgId !== 'string') return res.status(400).json({ error: 'orgId required' });

    // Membership guard: caller must belong to the org they are writing to.
    const memberships = await clerkClient.users.getOrganizationMembershipList({ userId, limit: 100 });
    const list = (memberships && memberships.data) || memberships || [];
    const isMember = list.some((m) => ((m && m.organization && m.organization.id) || (m && m.organizationId)) === orgId);
    if (!isMember) return res.status(403).json({ error: 'Not a member of this workspace' });

    const cleanDomains = normDomainList(domains);

    const org = await clerkClient.organizations.getOrganization({ organizationId: orgId });
    const existingMeta = (org && org.publicMetadata) || {};
    await clerkClient.organizations.updateOrganization(orgId, {
      publicMetadata: { ...existingMeta, domains: cleanDomains },
    });

    return res.status(200).json({ success: true, domains: cleanDomains });
  } catch (err) {
    console.error('[client-domains] error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
