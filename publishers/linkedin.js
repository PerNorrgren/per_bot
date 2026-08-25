// ── LinkedIn provider (Per App 30) ──
// Direct integration with LinkedIn's own Posts API — no BulkPublish in
// the middle. Personal-profile posting only (w_member_social), which is
// fully self-serve: add the "Share on LinkedIn" and "Sign In with
// LinkedIn using OpenID Connect" products to a LinkedIn Developer App
// and there's no partner-approval wait, unlike Facebook/Instagram/
// Threads which need Meta App Review. This is why LinkedIn is the
// starter provider for the new modular publishing layer.
//
// LinkedIn access tokens last 60 days, refresh tokens 365 days — a
// human has to re-consent once a year, not more often. getValidAccessToken()
// refreshes automatically well before the 60-day access token expires;
// nothing else needs to think about this.
const db = require('../db');

const CLIENT_ID     = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const REDIRECT_URI  = process.env.LINKEDIN_REDIRECT_URI; // e.g. https://<app>.up.railway.app/auth/linkedin/callback

// LinkedIn versions its REST API by a required header, cut monthly
// (YYYYMM), each supported for a minimum of one year. Override via env
// var if this ever needs bumping without a redeploy; the hardcoded
// fallback just needs revisiting occasionally rather than every month.
const LI_VERSION = process.env.LINKEDIN_API_VERSION || '202608';

const AUTH_URL    = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL   = 'https://www.linkedin.com/oauth/v2/accessToken';
const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';
const POSTS_URL    = 'https://api.linkedin.com/rest/posts';
const API_BASE     = 'https://api.linkedin.com/rest';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Personal-profile posting only, on purpose — Company Page posting
// (w_organization_social) was explicitly ruled out as a use case.
const SCOPES = 'openid profile w_member_social';

function configured() {
  return !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

function getAuthUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state,
    scope: SCOPES,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `LinkedIn token exchange returned ${res.status}`);
  return data; // { access_token, expires_in, refresh_token, refresh_token_expires_in }
}

async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `LinkedIn token refresh returned ${res.status}`);
  return data;
}

async function fetchMemberInfo(accessToken) {
  const res = await fetch(USERINFO_URL, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `LinkedIn userinfo returned ${res.status}`);
  return data; // { sub, name, ... }
}

// Called by the /auth/linkedin/callback route once the code has been
// exchanged and the member's identity fetched.
function saveConnection({ access_token, expires_in, refresh_token, refresh_token_expires_in }, memberInfo, connectedBy) {
  const now = Date.now();
  db.upsertOAuthConnection('linkedin', {
    access_token,
    refresh_token: refresh_token || null,
    expires_at: new Date(now + (expires_in || 0) * 1000).toISOString(),
    refresh_expires_at: refresh_token_expires_in ? new Date(now + refresh_token_expires_in * 1000).toISOString() : null,
    account_name: memberInfo.name || null,
    account_urn: `urn:li:person:${memberInfo.sub}`,
    connected_by: connectedBy || null,
  });
}

// Returns a definitely-valid access token, refreshing first if the
// stored one is expired or about to be (5-minute buffer so a slow
// request never lands mid-expiry). Throws a clear, admin-facing error
// if LinkedIn was never connected at all.
async function getValidAccessToken() {
  const conn = db.getOAuthConnection('linkedin');
  if (!conn || !conn.access_token) {
    throw new Error('LinkedIn isn\u2019t connected yet — connect it from the Channels area first.');
  }
  const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;
  const needsRefresh = !expiresAt || (expiresAt - Date.now()) < 5 * 60 * 1000;
  if (!needsRefresh) return conn.access_token;

  if (!conn.refresh_token) {
    throw new Error('LinkedIn\u2019s connection has expired and there\u2019s no refresh token on file — reconnect it from the Channels area.');
  }
  const refreshed = await refreshAccessToken(conn.refresh_token);
  const now = Date.now();
  db.updateOAuthTokens('linkedin', {
    access_token: refreshed.access_token,
    expires_at: new Date(now + (refreshed.expires_in || 0) * 1000).toISOString(),
    // LinkedIn may or may not rotate the refresh token itself on refresh;
    // keep the existing one unless a new one comes back.
    refresh_token: refreshed.refresh_token || conn.refresh_token,
    refresh_expires_at: refreshed.refresh_token_expires_in
      ? new Date(now + refreshed.refresh_token_expires_in * 1000).toISOString()
      : conn.refresh_expires_at,
  });
  return refreshed.access_token;
}

function disconnect() {
  db.deleteOAuthConnection('linkedin');
}

async function listChannels() {
  const conn = db.getOAuthConnection('linkedin');
  if (!conn || !conn.access_token) {
    return [{ platform: 'linkedin', connected: false, provider: 'linkedin' }];
  }
  return [{
    platform: 'linkedin',
    id: conn.account_urn,
    name: conn.account_name ? `${conn.account_name} (LinkedIn — personal)` : 'LinkedIn (personal)',
    connected: true,
    provider: 'linkedin',
    expiresAt: conn.expires_at,
  }];
}

// Per App 30 — fetches the actual bytes of one of this app's own hosted
// media URLs (an R2-generated image, or a saved Video Generator render).
// LinkedIn has no "upload by URL" option — every asset has to be
// registered, then the raw bytes PUT to a LinkedIn-issued upload target,
// so the media always has to pass through here first.
async function fetchMediaBytes(mediaUrl) {
  const res = await fetch(mediaUrl);
  if (!res.ok) throw new Error(`Could not fetch the media to upload (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

// LinkedIn processes uploaded media asynchronously — referencing an
// asset's URN in a post before it's finished processing reliably fails.
// Polls a handful of times with a short wait between; not fatal if it
// times out without seeing AVAILABLE (some assets do work referenced
// mid-processing per LinkedIn's own examples) — the post attempt itself
// will surface any real problem clearly enough either way.
async function waitForAssetAvailable(assetUrl, accessToken, maxTries = 8, delayMs = 2000) {
  for (let i = 0; i < maxTries; i++) {
    const res = await fetch(assetUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}`, 'X-Restli-Protocol-Version': '2.0.0', 'LinkedIn-Version': LI_VERSION },
    });
    const data = await res.json().catch(() => ({}));
    if (data.status === 'AVAILABLE') return;
    if (data.status === 'PROCESSING_FAILED' || data.status === 'FAILED') throw new Error('LinkedIn could not process the uploaded media.');
    await sleep(delayMs);
  }
}

// Images API: register -> PUT the bytes -> wait for processing. Three
// calls for what looks like it should be one — this is LinkedIn's own
// documented shape, not something simplifiable further.
async function uploadImage(mediaUrl, ownerUrn, accessToken) {
  const initRes = await fetch(`${API_BASE}/images?action=initializeUpload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0', 'LinkedIn-Version': LI_VERSION,
    },
    body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
  });
  const initData = await initRes.json().catch(() => ({}));
  if (!initRes.ok) throw new Error(initData.message || `LinkedIn image upload setup returned ${initRes.status}`);
  const { uploadUrl, image: imageUrn } = initData.value || {};
  if (!uploadUrl || !imageUrn) throw new Error('LinkedIn did not return an upload target for the image.');

  const bytes = await fetchMediaBytes(mediaUrl);
  const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Authorization': `Bearer ${accessToken}` }, body: bytes });
  if (!putRes.ok) throw new Error(`Uploading the image to LinkedIn failed (${putRes.status}).`);

  await waitForAssetAvailable(`${API_BASE}/images/${encodeURIComponent(imageUrn)}`, accessToken);
  return imageUrn;
}

// Videos API: register (with a real file size — required, unlike
// images) -> PUT each byte-range chunk to its own issued upload target
// -> finalize with the uploadToken plus every part's ETag, in order.
//
// Bug fix (Per App 30) — the original version here assumed a single
// upload part always, using only uploadInstructions[0] and PUTting the
// *entire* file to it. That's wrong: LinkedIn always splits video into
// fixed 4MB (4194304-byte) parts, even a small file gets exactly one
// part covering its whole size, but anything over 4MB gets multiple
// parts, each expecting only its own byte range. Sending the whole file
// to a single 4MB part's endpoint is exactly what LinkedIn's own upload
// server was rejecting with 413 Payload Too Large — it wasn't a size
// limit on the video overall, it was every part after the first getting
// silently dropped and the first part receiving far more bytes than its
// declared range. This now genuinely slices the buffer per part's
// firstByte/lastByte (both inclusive) and uploads each separately.
async function uploadVideo(mediaUrl, ownerUrn, accessToken) {
  const bytes = await fetchMediaBytes(mediaUrl);
  const initRes = await fetch(`${API_BASE}/videos?action=initializeUpload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0', 'LinkedIn-Version': LI_VERSION,
    },
    body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn, fileSizeBytes: bytes.length, uploadCaptions: false, uploadThumbnail: false } }),
  });
  const initData = await initRes.json().catch(() => ({}));
  if (!initRes.ok) throw new Error(initData.message || `LinkedIn video upload setup returned ${initRes.status}`);
  const { video: videoUrn, uploadInstructions, uploadToken } = initData.value || {};
  if (!videoUrn || !uploadInstructions || !uploadInstructions.length) {
    throw new Error('LinkedIn did not return an upload target for the video.');
  }

  // Parts are returned already sorted by byte range (LinkedIn's own
  // documented guarantee) — uploaded in that same order, sequentially,
  // since uploadedPartIds below has to line up positionally with them.
  const partIds = [];
  for (const part of uploadInstructions) {
    const chunk = bytes.subarray(part.firstByte, part.lastByte + 1); // lastByte is inclusive
    const putRes = await fetch(part.uploadUrl, { method: 'PUT', headers: { 'Authorization': `Bearer ${accessToken}` }, body: chunk });
    if (!putRes.ok) throw new Error(`Uploading part of the video to LinkedIn failed (${putRes.status}).`);
    const etag = putRes.headers.get('etag') || putRes.headers.get('ETag');
    if (!etag) throw new Error('LinkedIn didn\u2019t return an ETag for an uploaded video part — cannot finalize.');
    partIds.push(etag);
  }

  const finalizeRes = await fetch(`${API_BASE}/videos?action=finalizeUpload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0', 'LinkedIn-Version': LI_VERSION,
    },
    body: JSON.stringify({ finalizeUploadRequest: { video: videoUrn, uploadToken: uploadToken || '', uploadedPartIds: partIds } }),
  });
  if (!finalizeRes.ok) {
    const finData = await finalizeRes.json().catch(() => ({}));
    throw new Error(finData.message || `Finalizing the LinkedIn video upload returned ${finalizeRes.status}`);
  }

  await waitForAssetAvailable(`${API_BASE}/videos/${encodeURIComponent(videoUrn)}`, accessToken, 15, 4000); // video processing takes longer than images
  return videoUrn;
}

// Per App 30 — now attaches media. mediaUrl is one of this app's own
// hosted URLs; mediaType ('image' | 'video') decides which upload flow
// runs. Text-only still works exactly as before when neither is passed
// — Facebook/Instagram/Threads' Publish button on a caption-only post,
// or LinkedIn the same way, are unaffected by any of this.
async function publish(platform, { content, mediaUrl, mediaType } = {}) {
  if (!content || !content.trim()) throw new Error('content is required to publish to LinkedIn.');
  const conn = db.getOAuthConnection('linkedin');
  if (!conn || !conn.account_urn) {
    throw new Error('LinkedIn isn\u2019t connected yet — connect it from the Channels area first.');
  }
  const accessToken = await getValidAccessToken();
  const body = {
    author: conn.account_urn,
    commentary: content,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  if (mediaUrl) {
    const urn = mediaType === 'video'
      ? await uploadVideo(mediaUrl, conn.account_urn, accessToken)
      : await uploadImage(mediaUrl, conn.account_urn, accessToken);
    body.content = mediaType === 'video'
      ? { media: { title: content.slice(0, 80), id: urn } }
      : { media: { id: urn } };
  }
  const res = await fetch(POSTS_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
      'LinkedIn-Version': LI_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.message || errData.error_description || `LinkedIn returned ${res.status}`);
  }
  // A successful post returns the new post's URN in the x-restli-id
  // response header, not the (empty) body.
  const postUrn = res.headers.get('x-restli-id') || null;
  return { id: postUrn, provider: 'linkedin', raw: { urn: postUrn } };
}

module.exports = {
  configured, getAuthUrl, exchangeCodeForToken, fetchMemberInfo, saveConnection,
  getValidAccessToken, disconnect, listChannels, publish,
};
