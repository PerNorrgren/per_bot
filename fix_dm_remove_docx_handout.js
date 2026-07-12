// ── Fix: Deeper Mindfulness — drop the docx Handout, keep the PDF (Per Bot 14) ──
// Per asked to keep only the PDF version of the Lesson 1 handout. Removes
// the docx library file (and its lesson_file_ref, via db.deleteLibraryFile's
// own cascade) — leaves the R2 object itself in place (harmless, unlinked)
// rather than adding delete-from-R2 machinery for a single file.
//
// IN-PROCESS ONLY, idempotent — safe to re-run (no-ops if already removed).

const db = require('./db');

async function runFix(log = console.log) {
  await db.getDb();

  const files = db.getLibraryFiles({}) || [];
  const docxHandout = files.find(f => f.original_name === 'dm-l1-handout-DM-Lession-1-Handout.docx');

  if (!docxHandout) {
    log('No docx handout found (already removed, or never imported under that name) — nothing to do.');
    return { removed: false };
  }

  const usage = db.getFileUsage(docxHandout.id);
  db.deleteLibraryFile(docxHandout.id);
  log(`Removed docx handout "${docxHandout.title}" (was linked into: ${usage.lessons.map(l => `${l.course_title} — ${l.lesson_title}`).join(', ') || 'nothing'}).`);
  return { removed: true };
}

module.exports = { runFix };

if (require.main === module) {
  runFix().catch(e => { console.error(e); process.exit(1); });
}
