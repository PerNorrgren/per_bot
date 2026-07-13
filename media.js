// ── media.js ──
// Cloudflare R2 integration (S3-compatible API) for content library storage.
//
// WHY R2, NOT THE RAILWAY VOLUME:
// Files uploaded through the app server (multer → disk) had a hard 50MB ceiling,
// every upload and every playback passed fully through Express, and media storage
// shared the same volume as the SQLite database. R2 removes all three problems:
// browsers upload and stream directly to/from R2 via presigned URLs, the file never
// touches the Node process, and R2 has zero egress fees (unlike S3) which matters
// for a platform where the same guided track gets played repeatedly.
//
// VOICE PROCESSING (ElevenLabs TTS, Deepgram STT) IS NOT AFFECTED BY THIS MODULE —
// that stays tightly coupled to Railway, live request/response, nothing to do with
// file storage. This module only handles static files: documents, audio, video.
//
// ACCESS CONTROL: presigned GET URLs are short-lived (10 minutes) and are only ever
// generated after the existing tier-gating check (canSeeFile/userMaxLevel in db.js)
// has already passed — see /api/content/library/:id/playback-url in server.js.
// This preserves the same Registered/Member/Client/Facilitator/Admin visibility
// cascade that already governs which files appear in a person's Content tab.

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const R2_ACCOUNT_ID  = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY  = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_KEY  = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET      = process.env.R2_BUCKET_NAME || 'per-bot-media';

const configured = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY && R2_SECRET_KEY);

const client = configured
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
      // Force path-style addressing (endpoint.com/bucket/key) instead of the AWS SDK v3
      // default of virtual-hosted-style (bucket.endpoint.com/key). The SDK was rewriting
      // our configured endpoint into a bucket-subdomain form (per-bot-media.ACCOUNT_ID.
      // r2.cloudflarestorage.com), and R2 returned SignatureDoesNotMatch against that form
      // — the canonical request R2 validated against showed method GET even though the
      // browser correctly sent PUT, which is exactly the kind of mismatch virtual-hosted-
      // style routing through a CDN layer can cause. Path-style is also the form
      // Cloudflare's own R2 + S3 SDK documentation recommends.
      forcePathStyle: true,
      // R2 is S3-compatible but doesn't fully support the newer AWS SDK's "flexible
      // checksums" feature (it adds x-amz-checksum-crc32 / x-amz-sdk-checksum-algorithm
      // headers to every PutObject by default as of recent SDK versions). Left enabled,
      // presigned PUT uploads from the browser would hang/timeout against R2's endpoint
      // with no error — exactly the symptom found during testing (upload stuck on
      // "Uploading..." with ERR_TIMED_OUT in the browser console, reproduced on multiple
      // file sizes, so not a fluke). Disabling request checksum calculation avoids R2
      // ever being sent headers it doesn't handle correctly.
      requestChecksumCalculation: 'WHEN_REQUIRED',
    })
  : null;

function isConfigured() { return configured; }

// Presigned PUT URL — browser uploads the file directly to R2, bypassing Express/multer.
// Expires quickly (10 min) since it's only used for the single upload it was issued for.
async function getUploadUrl(key, contentType) {
  if (!client) throw new Error('R2 is not configured — missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY.');
  const cmd = new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: contentType });
  return getSignedUrl(client, cmd, { expiresIn: 600 });
}

// Presigned GET URL — only ever called AFTER the caller has already checked the
// requester's tier against the file's visibility. Short-lived so a copied/shared
// link goes stale quickly rather than working forever.
async function getPlaybackUrl(key) {
  if (!client) throw new Error('R2 is not configured.');
  const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
  return getSignedUrl(client, cmd, { expiresIn: 600 });
}

// Cheap existence check — HEAD, not GET, so it doesn't pull the object body
// over the wire just to confirm it's there. Used by the R2 orphan sweep
// (Per Bot 15) to check every R2-stored library_files row against the
// real bucket without downloading anything.
async function objectExists(key) {
  if (!client) throw new Error('R2 is not configured.');
  try {
    await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
    throw e; // some other failure (auth, network) — don't silently report as "missing"
  }
}

async function deleteObject(key) {
  if (!client) throw new Error('R2 is not configured.');
  await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}

// ── Public objects (newsletter images) ──
// Everything above (getUploadUrl/getPlaybackUrl) is deliberately private —
// presigned, short-lived, gated behind the tier-check in server.js. Newsletter
// images are the opposite case: they need to render in an email opened by
// anyone, including newsletter-only contacts who have no account to log into
// at all, so there's no "check access, then sign a URL" step that could ever
// run. Rather than reconfigure the R2 bucket itself for public access (a
// Cloudflare-dashboard change, not something this code can do), the server
// just uploads and re-serves these objects directly — see
// GET /newsletter-images/:key in server.js, which streams straight from R2
// with no auth check, by design, for exactly this content type only.
// Direct server-side PUT for one-off import/migration scripts (e.g. the
// WordPress content migration, Per Bot 13) — same underlying PutObjectCommand
// as uploadPublicObject below, but named separately since these keys are
// private library content served through the existing presigned-GET/tier-
// check path (getPlaybackUrl), not the public no-auth route. Kept distinct
// from getUploadUrl (which returns a presigned PUT for the browser) because
// a script runs server-side and can just write the bytes directly.
async function putObject(key, buffer, contentType) {
  if (!client) throw new Error('R2 is not configured — missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY.');
  await client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buffer, ContentType: contentType }));
}

async function uploadPublicObject(key, buffer, contentType) {
  if (!client) throw new Error('R2 is not configured — missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY.');
  await client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buffer, ContentType: contentType }));
}
async function getPublicObject(key) {
  if (!client) throw new Error('R2 is not configured.');
  const result = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  return result; // .Body is a readable stream; .ContentType is the stored MIME type
}

module.exports = { isConfigured, getUploadUrl, getPlaybackUrl, deleteObject, putObject, uploadPublicObject, getPublicObject, objectExists, R2_BUCKET };
