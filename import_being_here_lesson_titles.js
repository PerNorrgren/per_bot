// ── One-off fix: rename "A Poem a Day for your nerves" lesson titles (Per Bot 13) ──
// Replaces "Complex N — [Clinical Name]" with a plain, warm title drawn
// from the lesson's own poems, no number in the text (the lesson list
// already shows the number separately in its own column, so this doesn't
// lose the sequence — it just stops the title itself reading like a
// syllabus entry for a course that's about poems, not performance).
//
// IN-PROCESS ONLY. Idempotent — safe to run more than once.

const db = require('./db');

const NEW_TITLES = {
  1: 'When Everything Feels Too Much',
  2: 'The Pull Toward Closeness',
  3: 'Stuck in Drive',
  4: 'Holding Your Ground',
  5: 'Is It Worth It?',
  6: 'Where Do I Stand?',
  7: 'Carrying Everyone',
  8: 'Losing Yourself in Closeness',
  9: 'Chasing Joy',
  10: 'This Life Is Brief',
};

async function runRename(log = console.log) {
  await db.getDb();

  // Found by a lesson title rather than the course title — same reasoning
  // as the lesson-descriptions script, since the course itself has already
  // been renamed once and may be again.
  const allCourses = db.getAllCourses();
  let course = null;
  for (const c of allCourses) {
    const lessons = db.getLessonsForCourse(c.id);
    if (lessons.some(l => /existential safety|everything feels too much/i.test(l.title))) { course = c; break; }
  }
  if (!course) throw new Error(`Could not find the course. Available courses: ${allCourses.map(c => `"${c.title}"`).join(', ')}`);

  const lessons = db.getLessonsForCourse(course.id);
  let updated = 0;

  for (const lesson of lessons) {
    const newTitle = NEW_TITLES[lesson.lesson_number];
    if (!newTitle) {
      log(`  SKIP (no new title mapped): Lesson ${lesson.lesson_number} — ${lesson.title}`);
      continue;
    }
    if (lesson.title === newTitle) {
      log(`  Already renamed: Lesson ${lesson.lesson_number} — ${newTitle}`);
      continue;
    }
    db.updateLesson(lesson.id, lesson.lesson_number, newTitle, lesson.description, lesson.visibility);
    log(`  Renamed: "${lesson.title}" -> "${newTitle}"`);
    updated++;
  }

  log(`Done. ${updated} lesson titles renamed.`);
  return { updated };
}

module.exports = { runRename };

if (require.main === module) {
  runRename().catch(e => { console.error(e); process.exit(1); });
}
