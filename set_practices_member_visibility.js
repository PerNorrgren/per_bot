// ── Set all practices to Member visibility (Per Bot 31) ── One-time.
// Per's request: put every practice/meditation in the library at Member
// (member_1) level as a baseline, then hand-pick specific ones down to
// Explorer (registered) afterward via the normal admin editor — rather
// than starting from whatever mixed visibility each file happened to
// have from upload time and hunting down the ones that are wrong.
//
// Scope: content_type in ('meditation','practice'), not archived. One-
// to-one assigned files (assigned_client_id set) are deliberately left
// alone — those are a specific person's private file, not general
// population content, and changing their visibility field wouldn't
// change who can see them anyway (assignment overrides the tier ladder
// entirely — see canSeeFile in db.js) but leaving the field untouched
// keeps the admin file list honest about what that file actually is.
// Safe to re-run — files already at 'member' are simply left as 'member'
// again; nothing accumulates or duplicates.
const db = require('./db');

const PRACTICE_CONTENT_TYPES = ['meditation', 'practice'];
const TARGET_VISIBILITY = 'member';

async function runImport(log) {
  let files = [];
  for (const contentType of PRACTICE_CONTENT_TYPES) {
    files = files.concat(db.getLibraryFiles({ contentType }));
  }
  log(`Found ${files.length} practice/meditation files (content_type in [${PRACTICE_CONTENT_TYPES.join(', ')}]).`);

  let changed = 0, alreadySet = 0, skippedAssigned = 0;
  for (const f of files) {
    if (f.assigned_client_id) {
      skippedAssigned++;
      log(`  SKIP (one-to-one assigned, left untouched): ${f.title}`);
      continue;
    }
    if (f.visibility === TARGET_VISIBILITY) {
      alreadySet++;
      continue;
    }
    db.updateLibraryFile(f.id, { visibility: TARGET_VISIBILITY });
    changed++;
    log(`  Member <- was '${f.visibility}': ${f.title}`);
  }

  const result = { totalFiles: files.length, changed, alreadySet, skippedAssigned };
  log(`Done. Set to Member: ${changed}. Already Member: ${alreadySet}. Skipped (one-to-one): ${skippedAssigned}. Total scanned: ${files.length}.`);
  return result;
}

module.exports = { runImport };
