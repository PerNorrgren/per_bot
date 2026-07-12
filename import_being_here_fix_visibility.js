// ── One-off fix: correct visibility on already-imported "Being Here" files (Per Bot 13) ──
// The text and audio imports (commits 37 and 41) mistakenly used
// visibility='client' — a much higher tier requiring the special is_client
// flag (real 1:1 clients), not just being logged in as a client-role
// account. Course content should use 'member', matching the existing Joy
// course convention. This updates every file already linked to a Being
// Here lesson (both text and audio) in place, without needing to re-run
// either import.
//
// IN-PROCESS ONLY, same reasoning as the other Per Bot 13 import routes.
// Idempotent: files already at 'member' are simply left alone.

const db = require('./db');

const COURSE_TITLE = 'Being Here';

async function runFix(log = console.log) {
  await db.getDb();

  const course = db.getAllCourses().find(c => c.title === COURSE_TITLE);
  if (!course) throw new Error(`Course "${COURSE_TITLE}" not found.`);

  const lessons = db.getLessonsForCourse(course.id);
  let checked = 0, fixed = 0;

  for (const lesson of lessons) {
    const files = db.getFilesForLesson(lesson.id);
    for (const f of files) {
      checked++;
      if (f.visibility !== 'member') {
        db.updateLibraryFile(f.id, { visibility: 'member' });
        log(`  Fixed: "${f.title}" (was "${f.visibility}")`);
        fixed++;
      }
    }
  }

  log(`Done. ${checked} files checked, ${fixed} corrected to "member" visibility.`);
  return { checked, fixed };
}

module.exports = { runFix };

if (require.main === module) {
  runFix().catch(e => { console.error(e); process.exit(1); });
}
