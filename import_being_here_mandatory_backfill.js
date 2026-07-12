// ── One-off fix: mark the 84 already-imported "Being Here" text poems as
// mandatory (Per Bot 13) ──
// The import script now sets mandatory=true for text poems going forward
// (commit after this one), but the 84 already imported need a retroactive
// backfill so the % complete / completion-prompt gating actually reflects
// something meaningful without manually checking ~84 boxes in admin.
//
// Audio files are deliberately left NOT mandatory — they're an alternative
// way to experience the same day's content (see the Read/Listen chooser),
// not an additional requirement on top of the text. If that's not the
// behaviour wanted, the per-file "mandatory" checkbox in Admin -> Courses
// -> Being Here can be used to adjust individual files by hand.
//
// IN-PROCESS ONLY, same reasoning as the other Per Bot 13 import routes.
// Idempotent — files already mandatory are simply left alone.

const db = require('./db');

const COURSE_TITLE = 'Being Here';

async function runBackfill(log = console.log) {
  await db.getDb();

  const course = db.getAllCourses().find(c => c.title === COURSE_TITLE);
  if (!course) throw new Error(`Course "${COURSE_TITLE}" not found.`);

  const lessons = db.getLessonsForCourse(course.id);
  let checked = 0, fixed = 0;

  for (const lesson of lessons) {
    const files = db.getFilesForLesson(lesson.id);
    for (const f of files) {
      checked++;
      const isTextPoem = f.file_type === 'text/html';
      if (isTextPoem && !f.mandatory) {
        db.setLessonFileRefMandatory(f.ref_id, true);
        log(`  Marked mandatory: "${f.title}"`);
        fixed++;
      }
    }
  }

  log(`Done. ${checked} files checked, ${fixed} marked mandatory.`);
  return { checked, fixed };
}

module.exports = { runBackfill };

if (require.main === module) {
  runBackfill().catch(e => { console.error(e); process.exit(1); });
}
