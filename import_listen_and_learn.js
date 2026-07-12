// ── Import: "Listen and Learn Mindfulness" course (Per Bot 13) ──
// The Mindfulness for Life course embedded into 40 guided meditations — a
// track a day, 5 days a week, for 8 weeks. Old (pre-dates FELT·FIBRE
// entirely), but still a live, working course format.
//
// Fetches all 40 tracks live from their original hosting — a WordPress.com
// staging domain, separate from deepermindfulness.org — uploads each to
// R2, creates the course + 8 lessons (Week 1-8), and links every track in
// as mandatory (audio-only course, no alternative format to opt out to).
//
// MUST run on Railway (or anywhere with real internet access) — fetches
// live URLs, which a sandboxed dev environment can't reach. In-process
// only, same reasoning as the other Per Bot 13 imports: shares the live
// server's own db singleton, so there's no race with its own save().
//
// Idempotent: skips any track already imported (matched by original_name),
// and reuses the course/lessons if they already exist.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const media = require('./media');

const TRACKS_PATH = path.join(__dirname, 'listen_and_learn_import', 'listen_and_learn_tracks.json');

const COURSE_TITLE = 'Listen and Learn Mindfulness';
const COURSE_DESCRIPTION = 'Effortlessly Effective Every Day. The Mindfulness for Life course, embedded into forty guided meditations — one track a day, five days a week, for eight weeks. The learning happens while you meditate: each ten-minute practice carries a teaching inside it, so you\'re not studying mindfulness before you practise it, you\'re absorbing it as you go. No group sessions, no schedule to keep beyond pressing play — just headphones and ten minutes, twice a day if you like.';

async function runImport(log = console.log) {
  if (!media.isConfigured()) {
    throw new Error('R2 is not configured — missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY.');
  }
  if (!fs.existsSync(TRACKS_PATH)) throw new Error(`Track map not found at ${TRACKS_PATH}.`);

  await db.getDb();

  const categories = db.getAllCategories();
  const deepMindfulness = categories.find(c => !c.parent_id && /deep mindfulness/i.test(c.name));
  if (!deepMindfulness) {
    const topCats = categories.filter(c => !c.parent_id);
    throw new Error(`No top-level "Deep Mindfulness" category found. Available: ${topCats.map(c => `"${c.name}"`).join(', ')}`);
  }

  const contentKinds = db.getAllContentKinds();
  const meditationKind = contentKinds.find(k => /meditation/i.test(k.label));
  if (!meditationKind) throw new Error('No "Practice / meditation" content kind found.');

  let course = db.getAllCourses().find(c => c.title === COURSE_TITLE);
  let courseId;
  if (course) {
    courseId = course.id;
    log(`Course "${COURSE_TITLE}" already exists — reusing (id ${courseId}).`);
  } else {
    courseId = crypto.randomUUID();
    db.createCourse(courseId, COURSE_TITLE, COURSE_DESCRIPTION, deepMindfulness.id, null, false, null);
    log(`Created course "${COURSE_TITLE}" (id ${courseId}).`);
  }

  const existingInstances = db.getInstancesForCourse(courseId);
  const openInstance = existingInstances.find(i => i.status === 'open');
  if (openInstance) {
    log(`Open instance already exists (id ${openInstance.id}) — reusing.`);
  } else {
    const instanceId = crypto.randomUUID();
    db.createCourseInstance(instanceId, courseId, 'self_paced', COURSE_TITLE, null, null, null, 0, null, 'open');
    log(`Created open self-paced instance (id ${instanceId}).`);
  }

  const weeks = JSON.parse(fs.readFileSync(TRACKS_PATH, 'utf8'));
  const existingLessons = db.getLessonsForCourse(courseId);
  const existingFiles = db.getLibraryFiles({ categoryId: deepMindfulness.id }) || [];
  const existingNames = new Set(existingFiles.map(f => f.original_name));

  let filesOk = 0, filesSkipped = 0, filesFailed = 0;

  for (const weekNum of Object.keys(weeks).map(Number).sort((a, b) => a - b)) {
    const days = weeks[weekNum];
    const lessonTitle = `Week ${weekNum}`;

    let lesson = existingLessons.find(l => l.lesson_number === weekNum);
    let lessonId;
    if (lesson) {
      lessonId = lesson.id;
      log(`Lesson "${lessonTitle}" already exists — reusing.`);
    } else {
      lessonId = crypto.randomUUID();
      db.createLesson(lessonId, courseId, weekNum, lessonTitle, '', 'client');
      log(`Created lesson: ${lessonTitle}`);
    }

    for (const day of days) {
      const originalName = `listen-and-learn-week${weekNum}-day${day.day}-${day.url.split('/').pop()}`;
      if (existingNames.has(originalName)) {
        log(`  SKIP (already imported): ${day.title}`);
        filesSkipped++;
        continue;
      }
      try {
        const resp = await fetch(day.url);
        if (!resp.ok) throw new Error(`fetch failed: HTTP ${resp.status}`);
        const buffer = Buffer.from(await resp.arrayBuffer());

        const key = `library/${crypto.randomUUID()}.mp3`;
        await media.putObject(key, buffer, 'audio/mpeg');

        const fileId = crypto.randomUUID();
        db.addLibraryFile(
          fileId,
          day.title,
          `Part of "Listen and Learn Mindfulness" — ${lessonTitle}.`,
          key,
          originalName,
          'audio/mpeg',
          buffer.length,
          deepMindfulness.id,
          null,
          'member',
          'r2',
          false,
          meditationKind.value,
          null,
          null
        );
        db.addLessonFileRef(crypto.randomUUID(), lessonId, fileId, day.day, true);

        log(`  OK: ${day.title} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
        filesOk++;
      } catch (e) {
        log(`  FAILED: ${day.title} — ${e.message}`);
        filesFailed++;
      }
    }
  }

  log(`Done. ${filesOk} tracks imported, ${filesSkipped} already present, ${filesFailed} failed.`);
  return { courseId, filesOk, filesSkipped, filesFailed };
}

module.exports = { runImport };

if (require.main === module) {
  runImport().catch(e => { console.error(e); process.exit(1); });
}
