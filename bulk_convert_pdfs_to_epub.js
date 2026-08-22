// Per's request — Settings → Maintenance → Scripts, one-off run.
//
// The client app already converts a PDF to a readable book the moment
// a student happens to open it (openContentFile → convertPdfOnDemand,
// public/client/index.html) — but that's lazy: a file nobody's opened
// yet just sits as a plain PDF indefinitely, and every "first open" for
// a given file makes that one student wait through a conversion. This
// script does the same conversion, eagerly, across every PDF still
// unconverted in the whole library in one pass — after this runs,
// convertPdfOnDemand's own check (file_type === 'application/pdf' &&
// !original_pdf_filename) simply finds nothing left to do for any file
// this successfully converts.
//
// Any future upload is unaffected either way — the upload route
// (POST /api/content/library, and the replace-file route) already
// converts a PDF at upload time automatically; this script only
// catches whatever was uploaded before that existed, or slipped
// through it for any reason.
//
// Same conversion logic and same DB update (markLibraryFileConverted)
// as the on-demand route in server.js — this just loops it across
// every eligible file instead of one at a time as people happen to
// read them. Runs in-process via the admin scripts runner (required
// for sql.js — see the standing architectural note in server.js/db.js
// about never running a one-off script as a standalone node process).

const db = require('./db');
const media = require('./media');
const { convertPdfToEpub } = require('./pdf-to-epub');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

function brandName() {
  const cfg = db.getAppConfig() || {};
  return cfg.brand_name || 'Deeper Mindfulness';
}

async function runImport(log) {
  if (!media.isConfigured()) {
    log('R2 storage is not configured — cannot convert anything. Nothing to do.');
    return { converted: 0, failed: 0, skipped: 0, total: 0 };
  }

  // Includes archived files too — an archived PDF can still be reached
  // via "Where used"/reference links, and there's no reason to leave it
  // stuck un-convertible forever just because it's not in the active
  // list right now.
  const files = db.getLibraryFiles({ includeArchived: true }).filter(f => f.file_type === 'application/pdf');
  log(`Found ${files.length} PDF file(s) still unconverted.`);
  if (!files.length) {
    log('Nothing to do — every PDF in the library is already converted.');
    return { converted: 0, failed: 0, skipped: 0, total: 0 };
  }

  const name = brandName();
  let converted = 0, failed = 0, skipped = 0;

  for (const file of files) {
    try {
      log(`Converting "${file.title}"...`);
      let pdfBuffer;
      if (file.storage_type === 'r2') {
        const obj = await media.getPublicObject(file.filename);
        const chunks = [];
        for await (const chunk of obj.Body) chunks.push(chunk);
        pdfBuffer = Buffer.concat(chunks);
      } else {
        // Legacy pre-R2 files stored on local disk — same fallback the
        // on-demand route uses.
        pdfBuffer = fs.readFileSync(path.join(__dirname, 'uploads', file.filename));
      }

      const epubBuffer = await convertPdfToEpub(pdfBuffer, file.title, name);
      if (!epubBuffer) {
        skipped++;
        log(`  Skipped "${file.title}" — could not convert (likely a scanned PDF with no real text layer). Left as a plain PDF, exactly as before.`);
        continue;
      }

      const epubKey = `library-epubs/${uuidv4()}.epub`;
      await media.putObject(epubKey, epubBuffer, 'application/epub+zip');

      // Give a legacy disk-stored PDF a real R2 home for the first
      // time, same as the on-demand route does — an R2-stored PDF is
      // simply reused as-is.
      let originalPdfKey = file.filename;
      if (file.storage_type !== 'r2') {
        originalPdfKey = `library-pdfs/${uuidv4()}.pdf`;
        await media.putObject(originalPdfKey, pdfBuffer, 'application/pdf');
      }

      db.markLibraryFileConverted(file.id, epubKey, originalPdfKey);
      converted++;
      log(`  Converted "${file.title}".`);
    } catch (e) {
      failed++;
      log(`  Failed to convert "${file.title}": ${e.message}`);
    }
  }

  log(`Done. Converted ${converted}, skipped ${skipped} (not convertible), failed ${failed}, out of ${files.length} total.`);
  return { converted, failed, skipped, total: files.length };
}

module.exports = { runImport };
