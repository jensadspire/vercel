/**
 * /api/meta-check — Diagnose Meta API setup
 * GET → returns pages, ad account info
 */
const FB_API = 'https://graph.facebook.com/v19.0';

export default async function handler(req, res) {
  const token = process.env.META_ACCESS_TOKEN;
  const adAccountId = process.env.META_AD_ACCOUNT_ID;

  try {
    // Check pages
    const pagesRes = await fetch(`${FB_API}/me/accounts?access_token=${token}`);
    const pages = await pagesRes.json();

    // Check ad account
    const accountRes = await fetch(`${FB_API}/${adAccountId}?fields=name,account_status,currency,timezone_name&access_token=${token}`);
    const account = await accountRes.json();

    // Check token permissions
    const permRes = await fetch(`${FB_API}/me/permissions?access_token=${token}`);
    const perms = await permRes.json();

    return res.status(200).json({
      pages: pages.data || [],
      pagesError: pages.error || null,
      account: account,
      accountError: account.error || null,
      permissions: perms.data?.filter(p => p.status === 'granted').map(p => p.permission) || [],
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
