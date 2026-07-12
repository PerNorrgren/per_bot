// ── One-off fix: swap mandatory flags for "Being Here" (Per Bot 13) ──
// The practice is meant to be heard with eyes closed, not read — so audio
// is the actual requirement, text is the optional alternative. This
// reverses the earlier backfill (text mandatory, audio not).
//
// IN-PROCESS ONLY. Idempotent — safe to run more than once.

const db = require('./db');

const COURSE_TITLE = 'Being Here';

async function runSwap(log = console.log) {
  await db.getDb();

  const course = db.getAllCourses().find(c => c.title === COURSE_TITLE);
  if (!course) throw new Error(`Course "${COURSE_TITLE}" not found.`);

  const lessons = db.getLessonsForCourse(course.id);
  let textFixed = 0, audioFixed = 0;

  for (const lesson of lessons) {
    const files = db.getFilesForLesson(lesson.id);
    for (const f of files) {
      const isText = f.file_type === 'text/html';
      const isAudio = f.file_type === 'audio/mpeg';
      if (isText && f.mandatory) {
        db.setLessonFileRefMandatory(f.ref_id, false);
        log(`  Text -> optional: "${f.title}"`);
        textFixed++;
      } else if (isAudio && !f.mandatory) {
        db.setLessonFileRefMandatory(f.ref_id, true);
        log(`  Audio -> mandatory: "${f.title}"`);
        audioFixed++;
      }
    }
  }

  log(`Done. ${textFixed} text files set optional, ${audioFixed} audio files set mandatory.`);
  return { textFixed, audioFixed };
}

module.exports = { runSwap };

if (require.main === module) {
  runSwap().catch(e => { console.error(e); process.exit(1); });
}
