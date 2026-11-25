// api/lib/scope.js
// ─────────────────────────────────────────────────────────────────────────────
// Workspace scope resolver for multi-tenant (agency) containment.
//
// Decodes the Clerk session JWT (x-clerk-session) the same way the stores already
// do, and returns the ACTIVE SCOPE used to key workspace data:
//
//   scope = active organization id (the agency's "client" workspace) when one is
//           active, otherwise the user id.
//
// Back-compat: an individual user with no active organization gets scope === userId,
// so data keyed as `…:owner:${scope}` is byte-identical to today's `…:owner:${userId}`.
// No migration; existing data and existing users are untouched. Containment only
// engages once a user is inside an organization.
//
// Clerk token shapes handled (robust to both):
//   • classic session claims → payload.org_id
//   • v2 compact claims      → payload.o.id
//
// Returns { userId, orgId, scope }. Any field is null when the token is missing,
// malformed, or expired — callers treat a null scope as "not signed in".
// ─────────────────────────────────────────────────────────────────────────────

export function scopeFromReq(req) {
  const empty = { userId: null, orgId: null, scope: null };
  const tok = (req && req.headers && req.headers['x-clerk-session']) || '';
  if (!tok) return empty;
  try {
    const parts = String(tok).split('.');
    if (parts.length !== 3) return empty;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (!payload.sub || !payload.exp || payload.exp <= now) return empty;
    const userId = payload.sub;
    const orgId = payload.org_id || (payload.o && payload.o.id) || null;
    return { userId, orgId, scope: orgId || userId };
  } catch (_) {
    return empty;
  }
}
