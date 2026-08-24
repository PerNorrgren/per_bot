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

// Text-only for now — same "media is a natural next step, not bundled
// in to keep the first real publish simple to verify" reasoning
// BulkPublish's own integration used. LinkedIn's media path needs a
// separate upload-then-reference flow (POST /rest/images first to get
// an asset URN, then reference it here), which is real work best done
// as its own follow-up once text posting is confirmed solid.
async function publish(platform, { content, mediaUrl } = {}) {
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
