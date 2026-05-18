// api/lib/slugify.js
//
// Utility for converting product names + campaign codes into short, URL-safe
// tokens used by the redirect endpoint at /r/{token}.
//
// Slugification rules:
//   - Lowercase everything
//   - Strip accents/diacritics (ø → o, é → e, ü → u, ß → ss, æ → ae, å → a)
//   - Replace any non-alphanumeric run with a single hyphen
//   - Trim leading/trailing hyphens
//   - Truncate at a word boundary so the full token stays <= MAX_TOKEN_LENGTH
//
// Token format: `{product-slug}-{campaign-code}`
// Max total length: 60 chars.
// Example: "small-love-selection-box-2026-05-da"

export const MAX_TOKEN_LENGTH = 60;

/**
 * Convert a free-form string (typically a product name) into a URL-safe slug.
 * Does NOT include the campaign code — that is appended by buildToken().
 *
 * @param {string} text   Raw input (e.g. "Small Love Selection Box")
 * @param {number} maxLen Max length of the returned slug (default: 50)
 * @returns {string}      e.g. "small-love-selection-box"
 */
export function slugify(text, maxLen = 50) {
  if (!text || typeof text !== 'string') return '';

  let slug = text
    .normalize('NFKD')                       // decompose: é → e + ́
    .replace(/ø/gi, 'o')                     // explicit Nordic handling
    .replace(/æ/gi, 'ae')
    .replace(/å/gi, 'a')
    .replace(/ß/gi, 'ss')
    .replace(/[\u0300-\u036f]/g, '')         // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')             // any non-alphanumeric run → '-'
    .replace(/^-+|-+$/g, '');                // trim leading/trailing hyphens

  if (slug.length <= maxLen) return slug;

  // Truncate at a word (hyphen) boundary, never mid-word if possible
  let truncated = slug.slice(0, maxLen);
  const lastHyphen = truncated.lastIndexOf('-');
  if (lastHyphen > maxLen * 0.5) {           // only use boundary if not too short
    truncated = truncated.slice(0, lastHyphen);
  }
  return truncated.replace(/-+$/, '');
}

/**
 * Build the full short-link token.
 * Format: `{product-slug}-{campaign-code}`
 * Guaranteed to be <= MAX_TOKEN_LENGTH chars.
 *
 * @param {string} productName  e.g. "Small Love Selection Box"
 * @param {string} campaignCode e.g. "2026-05-da"
 * @returns {string}            e.g. "small-love-selection-box-2026-05-da"
 */
export function buildToken(productName, campaignCode) {
  const cleanCampaign = String(campaignCode || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Reserve room for "-{campaignCode}" in the total budget
  const reserved = cleanCampaign.length + 1; // +1 for the joining hyphen
  const slugBudget = Math.max(8, MAX_TOKEN_LENGTH - reserved);

  const slug = slugify(productName, slugBudget);
  if (!slug)          return cleanCampaign || '';
  if (!cleanCampaign) return slug;
  return `${slug}-${cleanCampaign}`;
}

/**
 * Append UTM parameters to a destination URL at redirect time.
 * Existing query params on the destination are preserved.
 *
 * @param {string} destination Full destination URL
 * @param {object} utm         { source, medium, campaign, content?, term? }
 * @returns {string}           destination with UTM params appended
 */
export function appendUtm(destination, utm = {}) {
  if (!destination) return destination;
  try {
    const u = new URL(destination);
    if (utm.source)   u.searchParams.set('utm_source',   utm.source);
    if (utm.medium)   u.searchParams.set('utm_medium',   utm.medium);
    if (utm.campaign) u.searchParams.set('utm_campaign', utm.campaign);
    if (utm.content)  u.searchParams.set('utm_content',  utm.content);
    if (utm.term)     u.searchParams.set('utm_term',     utm.term);
    return u.toString();
  } catch {
    return destination; // if the destination isn't a valid URL, return as-is
  }
}
