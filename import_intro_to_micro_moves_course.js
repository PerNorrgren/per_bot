// ── Import: "Introduction to Micro Moves" course (Per Bot 14) ──
// Renamed from the WordPress course "One Micro-Move Ahead (MMPM)" — Per's
// call: the WordPress course never grew past a single introductory video,
// so rather than import it as a stub "MMPM" course, it's brought in under
// its honest scope as a one-lesson introduction. Per is writing the
// course description/marketing copy separately (in Admin, after this
// runs) rather than pulling anything from the WordPress course body.
//
// Deliberately minimal: one lesson, one video, nothing else — no
// practices, no handout, no notes file, because none exist attached to
// this lesson in the export.
//
// Worth flagging separately (not acted on here): the WordPress media
// library has around 50 unattached MMPM-titled practice audio files
// (grounding, difficulty, sleep, arousal, etc.) plus two real PDFs
// ("Micro-Manage your Mind" and a flipbook version) sitting in the
// export, uploaded but never linked into any lesson. Spotted while
// building this manifest — a candidate for a proper practice library
// build later, well beyond today's one-video scope.
//
// IN-PROCESS ONLY — sql.js keeps the whole DB in memory per process, so
// this must run inside the live server via the admin route in server.js.
//
// MUST run on Railway — fetches the live video URL from
// deepermindfulness.org.
//
// Idempotent: skips the file if already imported, reuses the
// course/lesson/instance if they already exist.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const media = require('./media');

const MANIFEST_PATH = path.join(__dirname, 'intro_to_micro_moves_import', 'imm_manifest.json');

const COURSE_TITLE = 'Introduction to Micro Moves';
// Deliberately a placeholder — Per is writing the real description
// separately. Left short rather than pulled from the old WordPress course
// body, so there's no risk of this getting mistaken for the final copy.
const COURSE_DESCRIPTION = 'An introduction to micro-moves — small, precise movements that help settle and steady the nervous system.';

async function fetchBuffer(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch failed: HTTP ${resp.status} — ${url}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function runImport(log = console.log) {
  if (!media.isConfigured()) {
    throw new Error('R2 is not configured — missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY.');
  }
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`Manifest not found at ${MANIFEST_PATH}.`);

  await db.getDb();

  const categories = db.getAllCategories();
  const mindfulness = categories.find(c => !c.parent_id && /^mindfulness$/i.test(c.name));
  if (!mindfulness) throw new Error(`No top-level "Mindfulness" category found. Available: ${categories.filter(c=>!c.parent_id).map(c=>`"${c.name}"`).join(', ')}`);

  let kinds = db.getAllContentKinds();
  let videoKind = kinds.find(k => k.value === 'video_lesson');
  if (!videoKind) {
    db.createContentKind(crypto.randomUUID(), 'video_lesson', 'Video lesson', 1.5);
    kinds = db.getAllContentKinds();
    videoKind = kinds.find(k => k.value === 'video_lesson');
    log('Created new content kind: "Video lesson".');
  }

  let course = db.getAllCourses().find(c => c.title === COURSE_TITLE);
  let courseId;
  if (course) {
    courseId = course.id;
    log(`Course "${COURSE_TITLE}" already exists — reusing (id ${courseId}).`);
  } else {
    courseId = crypto.randomUUID();
    db.createCourse(courseId, COURSE_TITLE, COURSE_DESCRIPTION, mindfulness.id, null, false, null);
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

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const existingLessons = db.getLessonsForCourse(courseId);
  const existingFiles = db.getLibraryFiles({ categoryId: mindfulness.id }) || [];
  const existingNames = new Set(existingFiles.map(f => f.original_name));

  let filesOk = 0, filesSkipped = 0, filesFailed = 0;

  const l = manifest['1'];
  let lesson = existingLessons.find(x => x.lesson_number === 1);
  let lessonId;
  if (lesson) {
    lessonId = lesson.id;
    log('Lesson 1 already exists — reusing.');
  } else {
    lessonId = crypto.randomUUID();
    db.createLesson(lessonId, courseId, 1, l.title, '', 'member');
    log(`Created lesson 1: ${l.title}`);
  }

  const v = l.video;
  const originalName = `imm-l1-video-${v.wp_id}-${(v.url||'').split('/').pop()}`;
  if (!v.url) {
    log(`  SKIP (no URL): ${v.label}`);
    filesFailed++;
  } else if (existingNames.has(originalName)) {
    log(`  SKIP (already imported): ${v.label}`);
    filesSkipped++;
  } else {
    try {
      const buffer = await fetchBuffer(v.url);
      const key = `library/${crypto.randomUUID()}.mp4`;
      await media.putObject(key, buffer, 'video/mp4');
      const fileId = crypto.randomUUID();
      db.addLibraryFile(fileId, `Introduction to Micro Moves — ${v.label}`,
        'Introduction to Micro Moves — the introductory video.',
        key, originalName, 'video/mp4', buffer.length,
        mindfulness.id, null, 'member', 'r2', false, videoKind.value, null, null);
      db.addLessonFileRef(crypto.randomUUID(), lessonId, fileId, 1, true);
      log(`  OK: ${v.label} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
      filesOk++;
    } catch (e) {
      log(`  FAILED: ${v.label} — ${e.message}`);
      filesFailed++;
    }
  }

  log(`Done. ${filesOk} files imported, ${filesSkipped} already present, ${filesFailed} failed/skipped.`);
  return { courseId, filesOk, filesSkipped, filesFailed };
}

module.exports = { runImport };

if (require.main === module) {
  runImport().catch(e => { console.error(e); process.exit(1); });
}
