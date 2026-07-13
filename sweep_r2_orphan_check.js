// ── R2 orphan check (Per Bot 15) ──
// Per Bot 14 fixed a real bug in PATCH /api/content/library/:id/rename:
// it used to overwrite `library_files.filename` unconditionally, even for
// R2-stored files — where that column IS the actual storage key, not a
// display name. Renaming an R2 file through that route silently repointed
// the DB record at a key that was never uploaded, orphaning the real
// object under its original UUID key while the DB pointed at nothing.
// That's exactly what broke the first book upload ("the specified key
// does not exist"). The route is fixed going forward, but nothing has
// ever checked whether any *other* R2 file was silently corrupted by the
// same bug before the fix landed — offered twice, never run.
//
// READ-ONLY. This script only ever calls HeadObject (media.objectExists)
// — it never writes to R2 or to the database. It reports; it doesn't fix.
// Any file it flags needs a human decision (re-upload, restore from a
// known-good key, or just re-title and move on) rather than an automatic
// repair, since there's no way to know from here what the *correct* key
// should have been.
//
// IN-PROCESS ONLY — same reasoning as every other one-off script in this
// repo: sql.js keeps the whole DB in memory per process, so this must run
// inside the live server via the admin route in server.js, never as a
// separate `node sweep_r2_orphan_check.js` against the Railway console.

const db = require('./db');
const media = require('./media');

async function runSweep(log = console.log) {
  if (!media.isConfigured()) throw new Error('R2 is not configured.');
  await db.getDb();

  const allFiles = db.getLibraryFiles({}) || [];
  const r2Files = allFiles.filter(f => f.storage_type === 'r2');

  log(`Checking ${r2Files.length} R2-stored library file(s) against the live bucket...`);

  const orphaned = [];
  const errored = [];
  let checked = 0;

  for (const f of r2Files) {
    try {
      const exists = await media.objectExists(f.filename);
      if (!exists) {
        orphaned.push({ id: f.id, title: f.title, key: f.filename, content_type: f.content_type });
        log(`  MISSING: "${f.title}" (id ${f.id}) — key "${f.filename}" not found in R2.`);
      }
    } catch (e) {
      errored.push({ id: f.id, title: f.title, key: f.filename, error: e.message });
      log(`  ERROR checking "${f.title}" (id ${f.id}): ${e.message}`);
    }
    checked++;
    if (checked % 25 === 0) log(`  ...${checked}/${r2Files.length} checked`);
  }

  // Also check unpacked-epub resources for any book that has epub_opf_path
  // set — the opf file itself is the one thing the reader can't work
  // without, so it's worth a targeted check even though the rename bug
  // never touched these keys directly (they're written once, at unpack
  // time, and never renamed afterward).
  const unpackedBooks = allFiles.filter(f => f.storage_type === 'r2' && f.epub_opf_path);
  log(`Checking ${unpackedBooks.length} unpacked book(s)' content.opf resource...`);
  const opfMissing = [];
  for (const f of unpackedBooks) {
    const r2Key = `epub-unpacked/${f.id}/${f.epub_opf_path}`;
    try {
      const exists = await media.objectExists(r2Key);
      if (!exists) {
        opfMissing.push({ id: f.id, title: f.title, key: r2Key });
        log(`  MISSING opf: "${f.title}" (id ${f.id}) — "${r2Key}" not found.`);
      }
    } catch (e) {
      log(`  ERROR checking opf for "${f.title}" (id ${f.id}): ${e.message}`);
    }
  }

  log(`Done. ${r2Files.length} checked, ${orphaned.length} orphaned, ${errored.length} errored, ${opfMissing.length} unpacked book(s) missing their opf.`);
  return {
    totalChecked: r2Files.length,
    orphaned,
    errored,
    opfMissing,
  };
}

module.exports = { runSweep };

if (require.main === module) {
  runSweep().catch(e => { console.error(e); process.exit(1); });
}
