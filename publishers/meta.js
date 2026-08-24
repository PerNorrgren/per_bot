// ── Meta provider (Per App 30) — NOT BUILT YET ──
// Placeholder only. Direct Meta Graph API integration for Facebook,
// Instagram, and Threads is blocked on Meta App Review (2-4 weeks,
// free once approved) — see PER_APP_30_CUTOVER.md "On the horizon" for
// the reasoning. BulkPublish continues to handle these three platforms
// (see publishers/bulkpublish.js) until this is built.
//
// When this gets built for real, it slots into publishers/index.js the
// same way linkedin.js did: implement configured() / listChannels() /
// publish(platform, postData) below, then flip the relevant entries in
// PLATFORM_PROVIDERS from 'bulkpublish' to 'meta'. Nothing in server.js
// or the admin UI needs to change to make that switch.

function configured() {
  return false;
}

async function listChannels() {
  return [];
}

async function publish() {
  throw new Error('Direct Meta publishing isn\u2019t built yet — this platform is still routed through BulkPublish.');
}

module.exports = { configured, listChannels, publish };
