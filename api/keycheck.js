/**
 * /api/keycheck — TEMPORARY diagnostic. Returns only the first/last 4 chars +
 * length of the CREATOMATE_API_KEY the running function actually reads, so we can
 * compare it to the known-good key WITHOUT exposing the full secret.
 * DELETE this file after debugging.
 */
export default async function handler(req, res) {
  const k = process.env.CREATOMATE_API_KEY || '';
  res.status(200).json({
    present: !!k,
    length: k.length,
    first4: k.slice(0, 4),
    last4: k.slice(-4),
    // also check for accidental whitespace, a classic culprit:
    hasLeadingSpace: k !== k.trimStart(),
    hasTrailingSpace: k !== k.trimEnd(),
  });
}
