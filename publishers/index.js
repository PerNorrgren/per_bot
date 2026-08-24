// ── Publisher registry (Per App 30) ──
// The modular internal publishing layer flagged back at Per Bot 54 and
// scoped in PER_APP_30_CUTOVER.md. One entry point — publishToChannel()
// — that every route and cron job calls instead of talking to
// BulkPublish (or LinkedIn, or eventually Meta) directly. Adding a new
// channel or swapping a platform from BulkPublish to a direct
// integration is a one-line change to PLATFORM_PROVIDERS below —
// nothing in server.js's routes or the admin UI ever needs to change.
const bulkpublish = require('./bulkpublish');
const linkedin    = require('./linkedin');
const meta        = require('./meta');

// platform key (lowercase, matches what the admin UI already sends) ->
// provider module. Facebook/Instagram/Threads stay on BulkPublish until
// meta.js is actually built; flip these three to 'meta' then.
const PLATFORM_PROVIDERS = {
  linkedin:  'linkedin',
  facebook:  'bulkpublish',
  instagram: 'bulkpublish',
  threads:   'bulkpublish',
};

const PROVIDERS = { bulkpublish, linkedin, meta };

function providerFor(platform) {
  const key = PLATFORM_PROVIDERS[(platform || '').toLowerCase()];
  return key ? PROVIDERS[key] : null;
}

async function publishToChannel(platform, postData) {
  const provider = providerFor(platform);
  if (!provider) throw new Error(`No publishing provider is configured for "${platform}".`);
  return provider.publish(platform, postData);
}

// Merges every distinct provider's channel list into one flat array —
// used by the admin channels status route. Each provider is only ever
// called once even if several platforms map to it (e.g. BulkPublish
// covers three platforms but its /channels call already returns all of
// them at once).
async function listAllChannels() {
  const uniqueProviderKeys = [...new Set(Object.values(PLATFORM_PROVIDERS))];
  const results = await Promise.all(
    uniqueProviderKeys.map(key => PROVIDERS[key].listChannels().catch(() => []))
  );
  return results.flat();
}

module.exports = { publishToChannel, listAllChannels, providerFor, PLATFORM_PROVIDERS, PROVIDERS };
