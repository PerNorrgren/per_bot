// ── Meditation theme tags — August 2026 batch (Per Bot 27) ── Applies the
// theme tags Per confirmed (in Meditation_Import_Review_v2.xlsx) to the
// 156 meditation-library files from the recent 161-file bulk upload that
// actually have a matching library_files row. Five of the original 161
// never made it into the library (upload didn't create a row for them —
// worth re-uploading separately if that was accidental) and one more
// ("MMPM Chapter 19 Energy and Motivation") turned out to already exist
// from the original July MMPM import and is already tagged 'motivation'
// — both excluded from this manifest rather than silently skipped here,
// so the log stays honest about exactly what ran.
//
// Matches by fileId directly (resolved once, against the 12 Aug backup,
// when this manifest was built) rather than re-matching by filename at
// run time — a file rename between now and running this wouldn't silently
// tag the wrong row. addFileTag is INSERT OR IGNORE against a
// UNIQUE(file_id, tag) constraint, so this is safe to run more than once.
const fs = require('fs');
const path = require('path');
const db = require('./db');

const MANIFEST_PATH = path.join(__dirname, 'meditation_tags_import', 'meditation_tags_manifest.json');

async function runImport(log) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  log(`Loaded ${manifest.length} entries from meditation_tags_manifest.json.`);

  let tagged = 0, tagsApplied = 0, notFound = 0;
  for (const entry of manifest) {
    const file = db.getLibraryFile ? db.getLibraryFile(entry.fileId) : null;
    // Fallback in case getLibraryFile isn't exported under that exact
    // name — addFileTag itself doesn't need the row, but a missing file
    // (deleted since the manifest was built) shouldn't fail silently.
    if (db.getLibraryFile && !file) {
      notFound++;
      log(`  SKIP (file no longer exists): ${entry.originalName}`);
      continue;
    }
    for (const tag of entry.tags) {
      if (!tag) continue;
      db.addFileTag(entry.fileId, tag);
      tagsApplied++;
    }
    tagged++;
    log(`  Tagged: ${entry.originalName} -> [${entry.tags.join(', ')}]`);
  }

  const result = { totalInManifest: manifest.length, filesTagged: tagged, tagsApplied, notFound };
  log(`Done. Files tagged: ${tagged}/${manifest.length}. Total tag rows applied: ${tagsApplied}. Not found: ${notFound}.`);
  return result;
}

module.exports = { runImport };
