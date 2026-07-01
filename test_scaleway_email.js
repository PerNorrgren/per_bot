// ── One-off test: Scaleway Transactional Email end-to-end send ──
// Confirms SCW_SECRET_KEY / SCW_PROJECT_ID are correct and a real send works.
// Sends ONE plain test email to ADMIN_EMAIL (or a hardcoded address below).
// Safe to re-run — just sends another test email, no DB writes, no side effects.
//
// HOW TO RUN (Railway console tab):
//   node test_scaleway_email.js
//
// WHAT TO CHECK AFTER RUNNING:
//   1. Console output below — should print "Scaleway TEM response: 200 ..." with
//      a message ID, not an error.
//   2. Your actual inbox — did the email arrive? Check spam too, first sends
//      from a freshly-verified domain sometimes land there.
//   3. If it fails with 401/403 — SCW_SECRET_KEY is wrong (likely the Access Key
//      was copied instead of the Secret Key from the one-time reveal screen).
//   4. If it fails with 400 — check SCW_PROJECT_ID matches the "Per Bot" project.

const SCW_SECRET_KEY = process.env.SCW_SECRET_KEY;
const SCW_PROJECT_ID = process.env.SCW_PROJECT_ID;
const SCW_TEM_REGION = process.env.SCW_TEM_REGION || 'fr-par';
const EMAIL_FROM     = process.env.EMAIL_FROM || 'per@deepermindfulness.org';

// Change this if you want the test sent somewhere other than ADMIN_EMAIL
const TEST_TO = process.env.ADMIN_EMAIL || 'per@deepermindfulness.org';

(async () => {
  console.log('── Scaleway TEM end-to-end test ──');
  console.log('SCW_SECRET_KEY set:', !!SCW_SECRET_KEY, SCW_SECRET_KEY ? `(${SCW_SECRET_KEY.length} chars)` : '');
  console.log('SCW_PROJECT_ID:', SCW_PROJECT_ID || '(not set)');
  console.log('SCW_TEM_REGION:', SCW_TEM_REGION);
  console.log('EMAIL_FROM:', EMAIL_FROM);
  console.log('Sending test to:', TEST_TO);
  console.log('');

  if (!SCW_SECRET_KEY || !SCW_PROJECT_ID) {
    console.error('ABORTING — SCW_SECRET_KEY or SCW_PROJECT_ID not set in this environment.');
    process.exit(1);
  }

  try {
    const res = await fetch(`https://api.scaleway.com/transactional-email/v1alpha1/regions/${SCW_TEM_REGION}/emails`, {
      method: 'POST',
      headers: { 'X-Auth-Token': SCW_SECRET_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: { name: 'Per Bot Test', email: EMAIL_FROM },
        to: [{ email: TEST_TO }],
        subject: 'Per Bot — Scaleway TEM test send',
        text: `This is a one-off test send confirming Scaleway Transactional Email is working end-to-end.\n\nSent at: ${new Date().toISOString()}\nFrom: ${EMAIL_FROM}\nRegion: ${SCW_TEM_REGION}\n\nIf you received this, the migration from Brevo is fully confirmed working.`,
        html: `<p>This is a one-off test send confirming Scaleway Transactional Email is working end-to-end.</p><p><strong>Sent at:</strong> ${new Date().toISOString()}<br><strong>From:</strong> ${EMAIL_FROM}<br><strong>Region:</strong> ${SCW_TEM_REGION}</p><p>If you received this, the migration from Brevo is fully confirmed working.</p>`,
        project_id: SCW_PROJECT_ID,
      })
    });

    const data = await res.json().catch(() => ({}));

    console.log('HTTP status:', res.status);
    console.log('Response body:', JSON.stringify(data, null, 2));

    if (res.ok) {
      console.log('');
      console.log('✅ SUCCESS — Scaleway accepted the send. Check the inbox (and spam folder) at', TEST_TO);
    } else {
      console.log('');
      console.error('❌ FAILED — Scaleway rejected the send. See status/body above.');
      if (res.status === 401 || res.status === 403) {
        console.error('   → Likely cause: SCW_SECRET_KEY is wrong. Check it\'s the Secret Key from the');
        console.error('     one-time reveal screen, not the Access Key visible in the IAM list view.');
      }
      if (res.status === 400) {
        console.error('   → Likely cause: SCW_PROJECT_ID mismatch, or EMAIL_FROM domain not verified.');
      }
    }
  } catch (e) {
    console.error('❌ FAILED — network/fetch error:', e.message);
  }
})();
