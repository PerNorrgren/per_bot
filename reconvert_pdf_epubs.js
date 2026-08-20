// ── reconvert_pdf_epubs.js ──
// Admin script (Settings > Maintenance > Scripts) — reconverts every
// already-converted PDF-to-EPUB library file with the CURRENT conversion
// logic (Per Bot 113's running-header/footer + FELT · FIBRE masthead
// stripping, and anything since). Needed because conversion only ever
// runs once per file — a document converted before that stripping fix
// existed has the old, unstripped content permanently baked into its
// stored epub, and simply opening it again is a no-op that never
// re-triggers conversion. This walks every such file and does what the
// admin force-reconvert endpoint (POST /convert-to-epub with
// {force:true}) does for one file at a time, in bulk.
//
// Real bug caught before this ever ran correctly: an earlier version of
// this was written as a standalone script (`node reconvert_pdf_epubs.js`
// run directly in the Railway console) — which failed immediately with
// "DB not initialised" (sql.js needs its own async getDb() load step,
// not just requiring db.js), and even once that was fixed, would have
// been a genuinely dangerous fix: a separate process loads its OWN
// in-memory copy of the database, writes its changes back to disk, but
// the LIVE server already has its own separate in-memory copy loaded
// and has no way to know about a change made from outside it — the next
// time the live server itself saves anything, it would silently
// overwrite this script's fix with its own stale copy. Rewritten to
// match this codebase's actual pattern instead: an admin-script module
// exporting async runImport(log), run IN-PROCESS by the live server via
// Settings > Maintenance, using the server's own already-initialized db
// connection — same as apply_meditation_tags.js / cleanup_tag_casing.js.
//
// Deliberately conservative per-file: one document failing to reconvert
// (a scanned PDF with no text layer, a network hiccup fetching from R2)
// is logged and skipped, never aborts the whole batch — every other
// file still gets its turn. Safe to re-run — anything already fixed just
// gets reconverted again harmlessly.

const db = require('./db');
const media = require('./media');
const { convertPdfToEpub } = require('./pdf-to-epub');
const { v4: uuidv4 } = require('uuid');

async function fetchOriginalPdf(key) {
  const obj = await media.getPublicObject(key);
  const chunks = [];
  for await (const chunk of obj.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function runImport(log) {
  if (!media.isConfigured()) {
    throw new Error('Media storage is not configured — cannot fetch original PDFs.');
  }

  const files = db.getConvertedPdfLibraryFiles();
  log(`Found ${files.length} already-converted PDF library file(s) to reconvert.`);

  let ok = 0, failed = 0, skipped = 0;
  for (const file of files) {
    try {
      log(`Reconverting: "${file.title}" (id ${file.id})...`);
      const pdfBuffer = await fetchOriginalPdf(file.original_pdf_filename);
      const epubBuffer = await convertPdfToEpub(pdfBuffer, file.title, 'Deeper Mindfulness');
      if (!epubBuffer) {
        log(`  Skipped — conversion returned null (likely a scanned PDF with no text layer).`);
        skipped++;
        continue;
      }
      const epubKey = `library-epubs/${uuidv4()}.epub`;
      await media.putObject(epubKey, epubBuffer, 'application/epub+zip');
      // Reuses original_pdf_filename as-is — it already points at a
      // stable R2 original, same as the admin force-reconvert endpoint.
      db.markLibraryFileConverted(file.id, epubKey, file.original_pdf_filename);
      log(`  Done.`);
      ok++;
    } catch (e) {
      log(`  FAILED: ${e.message}`);
      failed++;
    }
  }

  const summary = `Reconversion complete: ${ok} succeeded, ${skipped} skipped, ${failed} failed.`;
  log(summary);
  return { ok, skipped, failed, total: files.length };
}

module.exports = { runImport };
