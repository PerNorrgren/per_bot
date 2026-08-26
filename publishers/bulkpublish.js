// ── BulkPublish provider (Per App 30) ──
// This is the exact BulkPublish logic that used to live directly in
// server.js (Per Bot 18 onward), moved here unchanged so it can sit
// behind the same shared interface as every other provider —
// listChannels() / publish(platform, postData). Handles Facebook,
// Instagram, and Threads today (LinkedIn moved to publishers/linkedin.js,
// which talks to LinkedIn directly instead of routing through
// BulkPublish). Nothing about how this actually talks to BulkPublish's
// API changed — only where the code lives.
const BULKPUBLISH_BASE = 'https://app.bulkpublish.com/api';

async function bulkPublishRequest(method, path, body) {
  const apiKey = process.env.BULKPUBLISH_API_KEY;
  if (!apiKey) throw new Error('BULKPUBLISH_API_KEY is not set — add it in Railway before publishing.');
  const res = await fetch(`${BULKPUBLISH_BASE}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(extractErrorMessage(data) || `BulkPublish returned ${res.status}`);
  return data;
}

// Per App 30 fix — data.error/.message from BulkPublish isn't always a
// plain string; some of their endpoints return a structured object
// instead (e.g. { error: { message: '...', code: '...' } }). The old
// code did `throw new Error(data.error || ...)` unconditionally — when
// data.error was an object, `new Error(anObject)` silently stringifies
// it via the object's default toString(), producing the literal text
// "[object Object]" as the whole error message, with the real reason
// lost. This normalises whatever shape comes back into an actual
// readable string before it ever reaches new Error(...).
function extractErrorMessage(data) {
  const raw = data && (data.error || data.message);
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') return raw.message || raw.error || raw.detail || JSON.stringify(raw);
  return String(raw);
}

function configured() {
  return !!process.env.BULKPUBLISH_API_KEY;
}

// Normalised to the same {platform, id, name, connected, provider} shape
// every provider's listChannels() returns, so publishers/index.js can
// merge results from several providers into one flat list without
// needing to know which provider each channel came from.
async function listChannels() {
  if (!configured()) return [];
  const { channels } = await bulkPublishRequest('GET', '/channels');
  return (channels || []).map(c => ({
    platform: (c.platform || '').toLowerCase(),
    id: c.id,
    name: c.name || c.platform,
    connected: true,
    provider: 'bulkpublish',
  }));
}

// Publishes with media as an optional attachment.
//
// Bug fix (Per App 30) — "status": "published" was never actually a
// valid value for BulkPublish's own create-post endpoint at all (their
// own docs and every example only ever show "draft" or "scheduled" —
// immediate publishing is done via "scheduled" with a
// near-immediate timestamp, or via a separate publish-a-draft action).
// This had been silently broken since it was first written; it only
// surfaced now because the real error message used to get lost to the
// "[object Object]" bug just above, so "status must be draft or
// scheduled" was never actually visible until that got fixed. Using
// status:'scheduled' with scheduled_at set a few seconds in the future
// is the documented, reliable way to get "post this right now" — it's
// BulkPublish's own scheduling engine firing it almost immediately,
// same mechanism the campaign /activate route already relies on for
// its own future-dated posts, just with a near-zero delay here.
async function publish(platform, { content, mediaUrl } = {}) {
  const { channels } = await bulkPublishRequest('GET', '/channels');
  const channel = (channels || []).find(c => (c.platform || '').toLowerCase() === platform.toLowerCase());
  if (!channel) throw new Error(`${platform} isn't connected in BulkPublish yet — connect it in the Channels page first.`);
  const publishBody = {
    content,
    channels: [{ channelId: channel.id, platform: channel.platform }],
    status: 'scheduled',
    // Bug fix (Per App 30, round 2) — "scheduledAt is required for
    // scheduled posts" confirmed the field name itself was wrong: their
    // Python/Node SDK wrapper accepts scheduled_at (snake_case) as a
    // convenience param, but the actual raw REST JSON field underneath
    // is scheduledAt (camelCase) — a common SDK-wrapper-vs-raw-API
    // naming mismatch, not a further status/logic problem.
    scheduledAt: new Date(Date.now() + 10000).toISOString(), // ~10s out — near-immediate, comfortably clear of "in the past" rejection
  };
  if (mediaUrl) publishBody.media = [{ url: mediaUrl }];
  const result = await bulkPublishRequest('POST', '/posts', publishBody);
  return {
    id: result?.post?.id || result?.id || null,
    channelId: channel.id,
    provider: 'bulkpublish',
    raw: result,
  };
}

module.exports = { configured, listChannels, publish, bulkPublishRequest };
