// ── Import: "Being Here" audio narrations (Per Bot 13) ──
// Fetches the 84 narrated poem recordings directly from the old WordPress
// site, uploads each to R2, creates a library_files row per day (content
// kind "Practice / meditation", same home as the text: Deep Mindfulness →
// Stress), and links it into the matching lesson right after that day's
// text poem.
//
// This is audio-only, deliberately — the poems are meant to be heard with
// eyes closed, not watched, so no video/image pass is needed here.
//
// MUST run on Railway (or anywhere with real internet access) — fetches
// live URLs from deepermindfulness.org, which a sandboxed dev environment
// can't reach. Same in-process reasoning as the other Per Bot 13 imports:
// runs inside the live server so there's no race with its own save().
//
// Idempotent: skips any day whose audio file (matched by original_name)
// already exists.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const media = require('./media');

const AUDIO_MAP_PATH = path.join(__dirname, 'being_here_import', 'being_here_audio_map.json');
const TEXT_MANIFEST_PATH = path.join(__dirname, 'being_here_import', 'manifest_full_84.json');

const COURSE_TITLE = 'Being Here';

async function runImport(log = console.log) {
  if (!media.isConfigured()) {
    throw new Error('R2 is not configured — missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY.');
  }
  if (!fs.existsSync(AUDIO_MAP_PATH)) throw new Error(`Audio map not found at ${AUDIO_MAP_PATH}.`);
  if (!fs.existsSync(TEXT_MANIFEST_PATH)) throw new Error(`Text manifest not found at ${TEXT_MANIFEST_PATH}.`);

  await db.getDb();

  const categories = db.getAllCategories();
  const deepMindfulness = categories.find(c => !c.parent_id && /deep mindfulness/i.test(c.name));
  if (!deepMindfulness) throw new Error('No top-level "Deep Mindfulness" category found.');
  const stressSub = db.getSubcategories(deepMindfulness.id).find(s => /stress/i.test(s.name));
  if (!stressSub) throw new Error('No "Stress" subcategory found under Deep Mindfulness.');

  const contentKinds = db.getAllContentKinds();
  const meditationKind = contentKinds.find(k => /meditation/i.test(k.label));
  if (!meditationKind) throw new Error('No "Practice / meditation" content kind found.');

  const course = db.getAllCourses().find(c => c.title === COURSE_TITLE);
  if (!course) throw new Error(`Course "${COURSE_TITLE}" not found — run the text import first.`);
  const lessons = db.getLessonsForCourse(course.id);

  const audioMap = JSON.parse(fs.readFileSync(AUDIO_MAP_PATH, 'utf8'));
  const textManifest = JSON.parse(fs.readFileSync(TEXT_MANIFEST_PATH, 'utf8'));
  const dayInfo = {};
  textManifest.forEach(m => { dayInfo[m.day] = m; });

  // Within-lesson day index (1-based position inside its own lesson) —
  // used to keep the audio's sort_order right after its matching text
  // entry (text used 1..9, audio uses 11..19, etc.) without needing to
  // look up the exact ref that was created for the text pass.
  const byComplex = {};
  textManifest.forEach(m => { (byComplex[m.complex] = byComplex[m.complex] || []).push(m); });
  Object.values(byComplex).forEach(days => {
    days.sort((a, b) => a.day - b.day).forEach((m, idx) => { m._withinLessonIndex = idx + 1; });
  });

  const existingFiles = db.getLibraryFiles({ categoryId: deepMindfulness.id }) || [];
  const existingNames = new Set(existingFiles.map(f => f.original_name));

  let ok = 0, skipped = 0, failed = 0;

  for (let day = 1; day <= 84; day++) {
    const url = audioMap[String(day)];
    const info = dayInfo[day];
    if (!url || !info) {
      log(`  SKIP (no data): Day ${day}`);
      skipped++;
      continue;
    }
    const originalName = `audio-day${String(day).padStart(2,'0')}-${url.split('/').pop()}`;
    if (existingNames.has(originalName)) {
      log(`  SKIP (already imported): Day ${day} audio`);
      skipped++;
      continue;
    }

    const lesson = lessons.find(l => l.lesson_number === info.complex);
    if (!lesson) {
      log(`  SKIP (no lesson for complex ${info.complex}): Day ${day}`);
      skipped++;
      continue;
    }

    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`fetch failed: HTTP ${resp.status}`);
      const arrayBuf = await resp.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);

      const key = `library/${crypto.randomUUID()}.mp3`;
      await media.putObject(key, buffer, 'audio/mpeg');

      const fileId = crypto.randomUUID();
      db.addLibraryFile(
        fileId,
        `Day ${day} — ${info.title} (audio)`,
        `Narrated version of the "Being Here" poem for Day ${day}, Complex ${info.complex} (${info.complex_name}).`,
        key,
        originalName,
        'audio/mpeg',
        buffer.length,
        deepMindfulness.id,
        stressSub.id,
        'member',
        'r2',
        false,
        meditationKind.value,
        null,
        null
      );
      db.addLessonFileRef(crypto.randomUUID(), lesson.id, fileId, info._withinLessonIndex + 10);

      log(`  OK: Day ${day} audio (${(buffer.length/1024/1024).toFixed(1)} MB)`);
      ok++;
    } catch (e) {
      log(`  FAILED: Day ${day} audio — ${e.message}`);
      failed++;
    }
  }

  log(`Done. ${ok} audio files imported, ${skipped} already present/skipped, ${failed} failed.`);
  return { ok, skipped, failed };
}

module.exports = { runImport };

if (require.main === module) {
  runImport().catch(e => { console.error(e); process.exit(1); });
}
