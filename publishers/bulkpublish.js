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

// Bug fix (Per App 30, round 3) — media was silently dropped entirely.
// Confirmed by downloading BulkPublish's own real npm package
// ("bulkpublish") and reading its actual client source rather than
// guessing a third time: posting `media: [{ url }]` isn't a recognised
// field at all — BulkPublish requires media to be uploaded as its own
// object first (POST /api/media, multipart/form-data, field name
// "file"), which returns a numeric file id, and THAT id is what a post
// references, via `mediaFiles: [id]` — not a raw URL inline in the post
// body. This fetches mediaUrl's bytes ourselves and re-uploads them,
// same as their own SDK does internally when given a URL to upload.
async function uploadMediaFromUrl(mediaUrl) {
  const apiKey = process.env.BULKPUBLISH_API_KEY;
  if (!apiKey) throw new Error('BULKPUBLISH_API_KEY is not set — add it in Railway before publishing.');
  const fileRes = await fetch(mediaUrl);
  if (!fileRes.ok) throw new Error(`Could not fetch media to upload to BulkPublish (${fileRes.status}).`);
  const contentType = fileRes.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  const fileName = mediaUrl.split('/').pop()?.split('?')[0] || 'upload';

  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: contentType }), fileName);
  const uploadRes = await fetch(`${BULKPUBLISH_BASE}/media`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` }, // no Content-Type — fetch sets the multipart boundary itself
    body: formData,
  });
  const uploadData = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok) throw new Error(extractErrorMessage(uploadData) || `BulkPublish media upload returned ${uploadRes.status}`);
  if (!uploadData.file || !uploadData.file.id) throw new Error('BulkPublish did not return a media file id.');
  return uploadData.file.id;
}

// Publishes with media as an optional attachment.
//
// Bug fix (Per App 30, round 2) — "status": "published" was never
// actually a valid value for BulkPublish's own create-post endpoint at
// all (their own docs and every example only ever show "draft" or
// "scheduled" — immediate publishing is done via "scheduled" with a
// near-immediate timestamp, or via a separate publish-a-draft action).
// This had been silently broken since it was first written; it only
// surfaced because the real error message used to get lost to the
// "[object Object]" bug above. Using status:'scheduled' with scheduledAt
// (camelCase — confirmed against their real client source, see
// uploadMediaFromUrl's comment above) a few seconds out is the
// documented, reliable way to get "post this right now" — BulkPublish's
// own scheduling engine firing it almost immediately, same mechanism the
// campaign /activate route already relies on for its own future-dated
// posts, just with a near-zero delay here.
async function publish(platform, { content, mediaUrl } = {}) {
  const { channels } = await bulkPublishRequest('GET', '/channels');
  const channel = (channels || []).find(c => (c.platform || '').toLowerCase() === platform.toLowerCase());
  if (!channel) throw new Error(`${platform} isn't connected in BulkPublish yet — connect it in the Channels page first.`);
  const publishBody = {
    content,
    channels: [{ channelId: channel.id, platform: channel.platform }],
    status: 'scheduled',
    scheduledAt: new Date(Date.now() + 10000).toISOString(), // ~10s out — near-immediate, comfortably clear of "in the past" rejection
  };
  if (mediaUrl) {
    const mediaFileId = await uploadMediaFromUrl(mediaUrl);
    publishBody.mediaFiles = [mediaFileId];
  }
  const result = await bulkPublishRequest('POST', '/posts', publishBody);
  return {
    id: result?.post?.id || result?.id || null,
    channelId: channel.id,
    provider: 'bulkpublish',
    raw: result,
  };
}

module.exports = { configured, listChannels, publish, bulkPublishRequest };
