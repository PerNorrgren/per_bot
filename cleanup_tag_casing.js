// ── Tag casing cleanup (Per Bot 28) ── The tag vocabulary had grown two
// parallel casings for several themes (e.g. 'Grounding' and 'grounding'
// both in live use, on different files) — almost certainly from different
// content types picking their own casing at different points rather than
// anyone doing this on purpose. Per confirmed: lowercase is the canonical
// form going forward.
//
// This can't be a blind SQL "UPDATE tag = LOWER(tag)" — a file that
// already carries both 'Grounding' and 'grounding' would collide against
// the UNIQUE(file_id, tag) constraint the moment the first one gets
// lowercased. Instead, per file: collect every tag it carries, lowercase
// and de-duplicate that set, delete all of that file's existing tag rows,
// then re-insert the deduplicated lowercase set via addFileTag (itself
// INSERT OR IGNORE, so re-running this is always safe). Net effect: same
// themes, same file coverage, one casing, no file loses or gains a theme
// it didn't already have under some casing.
const db = require('./db');

async function runImport(log) {
  const rows = db.getAllFileTagRows();
  log(`Loaded ${rows.length} existing tag rows.`);

  const byFile = {};
  rows.forEach(r => {
    if (!byFile[r.file_id]) byFile[r.file_id] = new Set();
    byFile[r.file_id].add(r.tag);
  });

  const fileIds = Object.keys(byFile);
  let filesChanged = 0, filesUnchanged = 0, tagRowsBefore = rows.length, tagRowsAfter = 0;

  for (const fileId of fileIds) {
    const original = byFile[fileId];
    const lowered = new Set([...original].map(t => t.trim().toLowerCase()));
    tagRowsAfter += lowered.size;

    const alreadyClean = original.size === lowered.size && [...original].every(t => t === t.toLowerCase());
    if (alreadyClean) {
      filesUnchanged++;
      continue;
    }

    // Clear this file's existing tag rows, then re-add the clean set.
    [...original].forEach(t => db.removeFileTag(fileId, t));
    [...lowered].forEach(t => db.addFileTag(fileId, t));
    filesChanged++;
    log(`  Merged: [${[...original].join(', ')}] -> [${[...lowered].join(', ')}] (file ${fileId})`);
  }

  const result = {
    filesScanned: fileIds.length,
    filesChanged,
    filesUnchanged,
    tagRowsBefore,
    tagRowsAfter,
  };
  log(`Done. Files changed: ${filesChanged}. Files already clean: ${filesUnchanged}. Tag rows: ${tagRowsBefore} -> ${tagRowsAfter}.`);
  return result;
}

module.exports = { runImport };
