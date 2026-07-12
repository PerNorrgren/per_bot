// ── Import: "Being Here" course — the ten-complex poem-a-day sequence (Per Bot 13) ──
// Creates the course, its 10 lessons (one per complex), uploads the 84 poem
// HTML files to R2, files each under Writing → Poems, and links each into
// its lesson via lesson_file_refs in day order.
//
// IN-PROCESS ONLY — same reasoning as import_blog_posts_batch1.js: sql.js
// keeps the database in memory per-process, so this must run inside the live
// server (see the admin route in server.js) rather than as a separate
// console script, or a later save() from the running server will silently
// overwrite what this script wrote.
//
// Idempotent: if a course titled "Being Here" already exists, it's reused
// rather than duplicated; poem files already present (matched by
// original_name) are skipped rather than re-uploaded.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const media = require('./media');

const IMPORT_DIR = path.join(__dirname, 'being_here_import');
const HTML_DIR = path.join(IMPORT_DIR, 'html');
const MANIFEST_PATH = path.join(IMPORT_DIR, 'manifest_full_84.json');

const COURSE_TITLE = 'Being Here';
const COURSE_DESCRIPTION = 'A poem a day, working through the ten emotional complexes that sit beneath most human suffering. Each complex is met on three consecutive days, through three different entry points into the same pattern: Meeting It Head On (a functional poem, working directly through the body), Reflecting (naming the experience in plain, honest language, without trying to change it), and Noticing (placing the experience within the wider human and social context it actually belongs to). Three separate channels into the same prior, rather than one channel repeated three times.';

async function runImport(log = console.log) {
  if (!media.isConfigured()) {
    throw new Error('R2 is not configured — missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY.');
  }
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found at ${MANIFEST_PATH}. Is ./being_here_import/ deployed?`);
  }

  await db.getDb();

  // Poems get filed under Deep Mindfulness → Stress, as "Course Material" —
  // matching the existing convention used by the other courses (e.g. the
  // Joy course's own lesson files), rather than the general Writing → Poems
  // home used for the standalone poem batch.
  const categories = db.getAllCategories();
  const deepMindfulness = categories.find(c => !c.parent_id && /deep mindfulness/i.test(c.name));
  if (!deepMindfulness) {
    const topCats = categories.filter(c => !c.parent_id);
    throw new Error(`No top-level "Deep Mindfulness" category found. Available top-level categories: ${topCats.map(c => `"${c.name}"`).join(', ')}`);
  }
  const stressSub = db.getSubcategories(deepMindfulness.id).find(s => /stress/i.test(s.name));
  if (!stressSub) {
    const subs = db.getSubcategories(deepMindfulness.id);
    throw new Error(`No "Stress" subcategory found under Deep Mindfulness. Available subcategories: ${subs.map(s => `"${s.name}"`).join(', ')}`);
  }

  const contentKinds = db.getAllContentKinds();
  const courseMaterialKind = contentKinds.find(k => /course material/i.test(k.label));
  if (!courseMaterialKind) {
    throw new Error(`No "Course Material" content kind found. Available kinds: ${contentKinds.map(k => `"${k.label}"`).join(', ')}`);
  }

  // Reuse the course if it already exists (idempotency).
  let course = db.getAllCourses().find(c => c.title === COURSE_TITLE);
  let courseId;
  if (course) {
    courseId = course.id;
    log(`Course "${COURSE_TITLE}" already exists — reusing (id ${courseId}).`);
  } else {
    courseId = crypto.randomUUID();
    db.createCourse(courseId, COURSE_TITLE, COURSE_DESCRIPTION, deepMindfulness.id, stressSub.id, false, null);
    log(`Created course "${COURSE_TITLE}" (id ${courseId}).`);
  }

  // A course row is just the template — nothing is enrollable to a client
  // until an actual open instance exists. Self-paced, free, no dates or
  // capacity: the simplest possible offering, same as browsing the lessons
  // directly.
  const existingInstances = db.getInstancesForCourse(courseId);
  const openInstance = existingInstances.find(i => i.status === 'open');
  if (openInstance) {
    log(`Open instance already exists (id ${openInstance.id}) — reusing.`);
  } else {
    const instanceId = crypto.randomUUID();
    db.createCourseInstance(instanceId, courseId, 'self_paced', COURSE_TITLE, null, null, null, 0, null, 'open');
    log(`Created open self-paced instance (id ${instanceId}).`);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const byComplex = {};
  manifest.forEach(m => { (byComplex[m.complex] = byComplex[m.complex] || []).push(m); });

  const existingLessons = db.getLessonsForCourse(courseId);
  const existingFiles = db.getLibraryFiles({ categoryId: deepMindfulness.id }) || [];
  const existingNames = new Set(existingFiles.map(f => f.original_name));

  let filesOk = 0, filesSkipped = 0, filesFailed = 0;

  for (const complexNum of Object.keys(byComplex).map(Number).sort((a,b) => a-b)) {
    const days = byComplex[complexNum].sort((a,b) => a.day - b.day);
    const complexName = days[0].complex_name;
    const lessonTitle = `Complex ${complexNum} — ${complexName}`;

    let lesson = existingLessons.find(l => l.lesson_number === complexNum);
    let lessonId;
    if (lesson) {
      lessonId = lesson.id;
      log(`Lesson ${complexNum} (${complexName}) already exists — reusing.`);
    } else {
      lessonId = crypto.randomUUID();
      db.createLesson(lessonId, courseId, complexNum, lessonTitle, '', 'client');
      log(`Created lesson ${complexNum}: ${lessonTitle}`);
    }

    let sortOrder = 0;
    for (const entry of days) {
      sortOrder++;
      if (existingNames.has(entry.filename)) {
        log(`  SKIP (already imported): Day ${entry.day} — ${entry.title}`);
        filesSkipped++;
        continue;
      }
      const filePath = path.join(HTML_DIR, entry.filename);
      if (!fs.existsSync(filePath)) {
        log(`  SKIP (file missing): ${entry.filename}`);
        filesFailed++;
        continue;
      }
      try {
        const buffer = fs.readFileSync(filePath);
        const key = `library/${crypto.randomUUID()}.html`;
        await media.putObject(key, buffer, 'text/html');

        const fileId = crypto.randomUUID();
        db.addLibraryFile(
          fileId,
          `Day ${entry.day} — ${entry.title}`,
          `Part of the "Being Here" course — Complex ${complexNum} (${complexName}).`,
          key,
          entry.filename,
          'text/html',
          buffer.length,
          deepMindfulness.id,
          stressSub.id,
          'client',
          'r2',
          false,
          courseMaterialKind.value,
          null,
          null
        );
        db.addLessonFileRef(crypto.randomUUID(), lessonId, fileId, sortOrder);

        log(`  OK: Day ${entry.day} — ${entry.title}`);
        filesOk++;
      } catch (e) {
        log(`  FAILED: Day ${entry.day} — ${entry.title} — ${e.message}`);
        filesFailed++;
      }
    }
  }

  log(`Done. ${filesOk} poems imported, ${filesSkipped} already present, ${filesFailed} failed/skipped.`);
  return { courseId, filesOk, filesSkipped, filesFailed };
}

module.exports = { runImport };

if (require.main === module) {
  runImport().catch(e => { console.error(e); process.exit(1); });
}
