// ── Unpack EPUB books for lazy in-app reading (Per Bot 14) ──
// The reader (epub.js) can either download a whole .epub and unzip it
// client-side, or fetch an already-unpacked book's individual chapter/
// resource files one at a time, on demand, straight from a directory of
// plain files. The first mode is fine for a short excerpt; for a full-
// length book it means downloading and unzipping the entire thing over
// mobile before the first page can even show — genuinely too slow, and
// exactly what a reader tapping a book on their phone actually hit.
//
// This script unzips a book's raw .epub (already sitting in R2 from the
// normal upload) into its individual internal files, re-uploads each one
// to R2 under its own key, and records the real path to content.opf
// (found via META-INF/container.xml — it isn't always at a fixed
// location) so the reader knows where to start. From then on, the
// client fetches chapters one at a time through
// GET /api/content/library/:id/epub-resource/* — same tier-gating as
// every other private file, just proxied per-resource instead of one
// big presigned URL.
//
// IN-PROCESS ONLY — sql.js keeps the whole DB in memory per process, so
// this must run inside the live server via the admin route in server.js.
//
// Idempotent: skips a book that already has epub_opf_path set, unless
// force-re-unpack is requested.

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const db = require('./db');
const media = require('./media');

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// The book uploaded through the normal Admin upload UI turned out to be
// legacy disk storage, not R2 — the first run of this script assumed R2
// unconditionally and failed with "the specified key does not exist."
// Same branch the rest of the app already uses (see the playback-url
// route) — R2 via media.getPublicObject, disk via a direct file read.
async function fetchRawBytes(fileRow) {
  if (fileRow.storage_type === 'r2') {
    const obj = await media.getPublicObject(fileRow.filename);
    return streamToBuffer(obj.Body);
  }
  return fs.readFileSync(path.join(__dirname, 'uploads', fileRow.filename));
}

function extToContentType(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return {
    xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html',
    css: 'text/css', js: 'application/javascript',
    opf: 'application/oebps-package+xml', ncx: 'application/x-dtbncx+xml',
    xml: 'application/xml',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml',
    otf: 'font/otf', ttf: 'font/ttf', woff: 'font/woff', woff2: 'font/woff2',
  }[ext] || 'application/octet-stream';
}

async function unpackOne(fileRow, log) {
  log(`Fetching ${fileRow.title}... (${fileRow.storage_type} storage)`);
  const buffer = await fetchRawBytes(fileRow);

  log(`Unzipping (${(buffer.length / 1024 / 1024).toFixed(1)} MB)...`);
  const zip = await JSZip.loadAsync(buffer);

  const containerXml = await zip.file('META-INF/container.xml')?.async('string');
  if (!containerXml) throw new Error('No META-INF/container.xml found — not a valid EPUB.');
  const m = containerXml.match(/full-path="([^"]+)"/);
  if (!m) throw new Error('Could not find content.opf path in container.xml.');
  const opfPath = m[1];

  const entries = Object.keys(zip.files).filter(p => !zip.files[p].dir);
  log(`Uploading ${entries.length} internal files...`);
  let uploaded = 0;
  for (const path of entries) {
    const fileBuffer = await zip.file(path).async('nodebuffer');
    const r2Key = `epub-unpacked/${fileRow.id}/${path}`;
    await media.putObject(r2Key, fileBuffer, extToContentType(path));
    uploaded++;
  }

  db.updateLibraryFile(fileRow.id, { epub_opf_path: opfPath });
  log(`Done: ${fileRow.title} — ${uploaded} files unpacked, opf at "${opfPath}".`);
}

async function runUnpack(log = console.log, targetFileId = null) {
  if (!media.isConfigured()) throw new Error('R2 is not configured.');
  await db.getDb();

  let targets;
  if (targetFileId) {
    const f = db.getLibraryFile(targetFileId);
    if (!f) throw new Error(`No library file found with id ${targetFileId}.`);
    targets = [f];
  } else {
    targets = (db.getLibraryFiles({}) || []).filter(f =>
      f.content_type === 'book' && f.file_type === 'application/epub+zip' && !f.epub_opf_path);
  }

  if (!targets.length) {
    log('Nothing to unpack — no book files need it.');
    return { unpacked: 0, failed: 0 };
  }

  let unpacked = 0, failed = 0;
  for (const f of targets) {
    try {
      await unpackOne(f, log);
      unpacked++;
    } catch (e) {
      log(`FAILED: ${f.title} — ${e.message}`);
      failed++;
    }
  }
  log(`Done. ${unpacked} book(s) unpacked, ${failed} failed.`);
  return { unpacked, failed };
}

module.exports = { runUnpack };

if (require.main === module) {
  runUnpack().catch(e => { console.error(e); process.exit(1); });
}
