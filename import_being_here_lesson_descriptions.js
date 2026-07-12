// ── One-off fix: plain-English lesson descriptions for "Being Here" (Per Bot 13) ──
// The lessons themselves were created with blank descriptions — fine for
// admin browsing, but the titles ("Complex 1 — Existential Safety") read
// like a textbook to an actual user with no clinical background. This adds
// a short, plain description per lesson (Gunning Fog ~6, no jargon) that
// explains what the lesson is actually about.
//
// IN-PROCESS ONLY. Idempotent — just overwrites with the same text if run
// again, no harm either way.

const fs = require('fs');
const path = require('path');
const db = require('./db');

const COURSE_TITLE = 'Being Here';
const DESCRIPTIONS_PATH = path.join(__dirname, 'being_here_lesson_descriptions.json');

async function runUpdate(log = console.log) {
  await db.getDb();

  if (!fs.existsSync(DESCRIPTIONS_PATH)) throw new Error(`Descriptions file not found at ${DESCRIPTIONS_PATH}.`);
  const descriptions = JSON.parse(fs.readFileSync(DESCRIPTIONS_PATH, 'utf8'));

  const course = db.getAllCourses().find(c => c.title === COURSE_TITLE);
  if (!course) throw new Error(`Course "${COURSE_TITLE}" not found.`);

  const lessons = db.getLessonsForCourse(course.id);
  let updated = 0;

  for (const lesson of lessons) {
    const desc = descriptions[String(lesson.lesson_number)];
    if (!desc) {
      log(`  SKIP (no description mapped): Lesson ${lesson.lesson_number} — ${lesson.title}`);
      continue;
    }
    db.updateLesson(lesson.id, lesson.lesson_number, lesson.title, desc, lesson.visibility);
    log(`  Updated: Lesson ${lesson.lesson_number} — ${lesson.title}`);
    updated++;
  }

  log(`Done. ${updated} lesson descriptions updated.`);
  return { updated };
}

module.exports = { runUpdate };

if (require.main === module) {
  runUpdate().catch(e => { console.error(e); process.exit(1); });
}
