// ── reconvert_pdf_epubs.js ──
// (Redeploy trigger — Railway's build scheduler stalled on the previous
// push and was cancelled before it ever built; this comment gives
// deploy.sh a real change to commit so a fresh build gets queued.)
// One-off migration, run once by hand: reconverts every PDF-to-EPUB
// library file with the CURRENT conversion logic (Per Bot 113's
// running-header/footer + FELT · FIBRE masthead stripping, and anything
// since). Needed because conversion only ever runs once per file — a
// document converted before that stripping fix existed has the old,
// unstripped content permanently baked into its stored epub, and simply
// opening it again is a no-op that never re-triggers conversion. This
// walks every such file and does what the admin force-reconvert endpoint
// (POST /api/content/library/:id/convert-to-epub with {force:true}) does
// for one file at a time, in bulk.
//
// Per's own sql.js in-process rule applies here too — this must run
// through the live server process (via `node reconvert_pdf_epubs.js` on
// the actual Railway instance, same as the other one-off scripts in this
// repo, not a local standalone run against a copy of the DB), or its
// writes are silent data loss the moment the real server's own in-memory
// DB overwrites this script's changes on next save.
//
// Deliberately conservative per-file: one document failing to reconvert
// (a scanned PDF with no text layer, a network hiccup fetching from R2)
// is logged and skipped, never aborts the whole batch — every other
// file still gets its turn.

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

async function main() {
  if (!media.isConfigured()) {
    console.error('Media storage is not configured — cannot fetch original PDFs. Aborting.');
    process.exit(1);
  }

  const files = db.getConvertedPdfLibraryFiles();
  console.log(`Found ${files.length} already-converted PDF library file(s) to reconvert.\n`);

  let ok = 0, failed = 0, skipped = 0;
  for (const file of files) {
    try {
      console.log(`Reconverting: "${file.title}" (id ${file.id})...`);
      const pdfBuffer = await fetchOriginalPdf(file.original_pdf_filename);
      const epubBuffer = await convertPdfToEpub(pdfBuffer, file.title, 'Deeper Mindfulness');
      if (!epubBuffer) {
        console.log(`  Skipped — conversion returned null (likely a scanned PDF with no text layer).`);
        skipped++;
        continue;
      }
      const epubKey = `library-epubs/${uuidv4()}.epub`;
      await media.putObject(epubKey, epubBuffer, 'application/epub+zip');
      // Reuses original_pdf_filename as-is — it already points at a
      // stable R2 original, same as the admin force-reconvert endpoint.
      db.markLibraryFileConverted(file.id, epubKey, file.original_pdf_filename);
      console.log(`  Done.`);
      ok++;
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
      failed++;
    }
  }

  console.log(`\nReconversion complete: ${ok} succeeded, ${skipped} skipped, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
