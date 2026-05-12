// /api/data-deletion-status.js
// Public-facing status page that confirms a data deletion request.
//
// When a user requests deletion via Facebook's "Apps and Websites" settings,
// Meta calls /api/meta-data-deletion (which actually deletes the data) and
// then shows the user this page URL with a confirmation code.
//
// Since we delete synchronously, by the time the user lands here, their data
// is already gone. This page just confirms that.

export default function handler(req, res) {
  const id = (req.query?.id || '').toString().slice(0, 32); // sanitise
  const safeId = id.replace(/[^a-zA-Z0-9]/g, '');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Data Deletion Status — AI Ad Studio</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
           max-width: 600px; margin: 60px auto; padding: 0 20px;
           color: #1a1a1a; line-height: 1.6; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .status { padding: 16px; background: #ecfdf5; border: 1px solid #6ee7b7;
              border-radius: 8px; margin: 24px 0; color: #065f46; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px;
           font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
    a { color: #6366f1; }
    .footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid #e5e7eb;
              font-size: 12px; color: #6b7280; }
  </style>
</head>
<body>
  <h1>Data Deletion Confirmation</h1>
  <p>Your request to delete your AI Ad Studio data has been processed.</p>

  <div class="status">
    <strong>✅ Status: Completed</strong><br>
    All Meta-related data associated with your account has been removed from our systems,
    including any stored access tokens and ad account / page selections.
  </div>

  ${safeId ? `<p>Your confirmation code: <code>${safeId}</code></p>` : ''}

  <h2 style="font-size: 16px; margin-top: 32px;">What was deleted?</h2>
  <ul>
    <li>Your Meta access token (encrypted, now removed from our database)</li>
    <li>The ad account ID and Facebook page ID you previously selected</li>
    <li>The Facebook user ID we stored to associate your Meta account with your AI Ad Studio profile</li>
  </ul>

  <h2 style="font-size: 16px; margin-top: 32px;">What about my AI Ad Studio account?</h2>
  <p>
    This deletion only removes data connected to your Meta account. Your AI Ad Studio
    profile (email, generated ads, etc.) is separate. To delete that as well, please
    contact <a href="mailto:info@adspire.de">info@adspire.de</a>.
  </p>

  <div class="footer">
    AI Ad Studio is developed by <strong>Adspire Deutschland GmbH</strong> · Friedensallee 9 · D-22765 Hamburg ·
    <a href="https://www.adspire.de">www.adspire.de</a>
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
}
