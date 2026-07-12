// ── Import: "Introduction to Mindfulness" course (Per Bot 14) ──
// 3-lesson video course — much shorter than DM/MFL. Creates the course +
// 3 lessons under Mindfulness → Introduction, uploads every video,
// practice audio, and lesson notes — live-fetched from
// deepermindfulness.org, same pattern as the DM/MFL imports.
//
// No extended playlist tracks (none exist in the export) and no real
// PDF/docx handout — the WordPress export has three items titled
// "Lesson N Handout" per lesson, but their actual content is the same
// rich blog-style write-up + header image + poem pattern as DM/MFL's
// "Lesson Notes", just mistitled. Imported here as notes, matching what
// they actually are rather than what WordPress called them.
//
// Notes go in as their own text/html library file from the start (the
// DM import got this wrong initially — see fix_deeper_mindfulness_
// lesson_notes.js and the Per Bot 14 handover — corrected here and in
// the MFL import before either shipped it wrong).
//
// L2 has noticeably less content than L1/L3 (1 practice vs 3) — flagged
// in the log, not silently padded or treated as an error; imported
// exactly as found in the export.
//
// IN-PROCESS ONLY — sql.js keeps the whole DB in memory per process, so
// this must run inside the live server via the admin route in server.js.
//
// MUST run on Railway — fetches live URLs from deepermindfulness.org.
//
// Idempotent: skips any file already imported (matched by original_name),
// reuses the course/lessons/instance if they already exist.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const media = require('./media');

const MANIFEST_PATH = path.join(__dirname, 'introduction_to_mindfulness_import', 'imfn_manifest.json');

const COURSE_TITLE = 'Introduction to Mindfulness';
const COURSE_DESCRIPTION = "A beginner's guide to calm and clarity. A short, three-lesson introduction to mindfulness — learning attention, discovering new ways of being with what's here, and shifting from reacting to responding.";

async function fetchBuffer(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch failed: HTTP ${resp.status} — ${url}`);
  return Buffer.from(await resp.arrayBuffer());
}

function extForUrl(url) {
  const m = /\.([a-z0-9]+)(?:\?|$)/i.exec(url);
  return m ? m[1].toLowerCase() : 'bin';
}

function mimeFor(ext) {
  return { mp4: 'video/mp4', mp3: 'audio/mpeg' }[ext] || 'application/octet-stream';
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
  // No dedicated "Introduction" subcategory exists yet under Mindfulness
  // (unlike Deeper Mindfulness / Mindfulness for Life, which both have
  // their own) — files it at the top Mindfulness level with no
  // subcategory rather than inventing one unprompted.
  const introSub = db.getSubcategories(mindfulness.id).find(s => /introduction/i.test(s.name)) || null;

  let kinds = db.getAllContentKinds();
  let videoKind = kinds.find(k => k.value === 'video_lesson');
  if (!videoKind) {
    db.createContentKind(crypto.randomUUID(), 'video_lesson', 'Video lesson', 1.5);
    kinds = db.getAllContentKinds();
    videoKind = kinds.find(k => k.value === 'video_lesson');
    log('Created new content kind: "Video lesson".');
  }
  const meditationKind = kinds.find(k => /meditation/i.test(k.label));
  if (!meditationKind) throw new Error('No "Practice / meditation" content kind found.');
  const blogKind = kinds.find(k => /blog/i.test(k.label)) || kinds.find(k => k.value === 'other');

  let course = db.getAllCourses().find(c => c.title === COURSE_TITLE);
  let courseId;
  if (course) {
    courseId = course.id;
    log(`Course "${COURSE_TITLE}" already exists — reusing (id ${courseId}).`);
  } else {
    courseId = crypto.randomUUID();
    db.createCourse(courseId, COURSE_TITLE, COURSE_DESCRIPTION, mindfulness.id, introSub ? introSub.id : null, false, null);
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

  async function importFile({ url, originalName, title, description, contentType, mandatory, lessonId, sortOrder }) {
    if (!url) { log(`  SKIP (no URL): ${title}`); filesFailed++; return; }
    if (existingNames.has(originalName)) { log(`  SKIP (already imported): ${title}`); filesSkipped++; return; }
    try {
      const buffer = await fetchBuffer(url);
      const ext = extForUrl(url);
      const key = `library/${crypto.randomUUID()}.${ext}`;
      await media.putObject(key, buffer, mimeFor(ext));

      const fileId = crypto.randomUUID();
      db.addLibraryFile(fileId, title, description, key, originalName, mimeFor(ext), buffer.length,
        mindfulness.id, introSub ? introSub.id : null, 'member', 'r2', false, contentType, null, null);
      db.addLessonFileRef(crypto.randomUUID(), lessonId, fileId, sortOrder, !!mandatory);

      existingNames.add(originalName);
      log(`  OK: ${title} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
      filesOk++;
    } catch (e) {
      log(`  FAILED: ${title} — ${e.message}`);
      filesFailed++;
    }
  }

  for (let lnum = 1; lnum <= 3; lnum++) {
    const l = manifest[String(lnum)];
    if (!l) continue;
    if (l.flag) log(`NOTE (Lesson ${lnum}): ${l.flag}`);

    let lesson = existingLessons.find(x => x.lesson_number === lnum);
    let lessonId;
    if (lesson) {
      lessonId = lesson.id;
      log(`Lesson ${lnum} already exists — reusing.`);
    } else {
      lessonId = crypto.randomUUID();
      db.createLesson(lessonId, courseId, lnum, l.title, '', 'member');
      log(`Created lesson ${lnum}: ${l.title}`);
    }

    let sortOrder = 0;

    for (const v of l.videos) {
      sortOrder++;
      const originalName = `imfn-l${lnum}-video-${v.wp_id}-${(v.url||'').split('/').pop()}`;
      await importFile({
        url: v.url, originalName, title: `Introduction to Mindfulness L${lnum} — ${v.label}`,
        description: `Introduction to Mindfulness — Lesson ${lnum}, ${v.label}.`,
        contentType: videoKind.value, mandatory: true, lessonId, sortOrder,
      });
    }

    for (const p of l.practices) {
      sortOrder++;
      const originalName = `imfn-l${lnum}-practice-${p.wp_id}-${(p.url||'').split('/').pop()}`;
      await importFile({
        url: p.url, originalName, title: `Introduction to Mindfulness L${lnum} — ${p.label}`,
        description: `Introduction to Mindfulness — Lesson ${lnum} practice audio.`,
        contentType: meditationKind.value, mandatory: true, lessonId, sortOrder,
      });
    }

    // Lesson notes — own text/html file, rendered inline in the player
    // overlay (same pattern as DM/MFL/Being Here), not the lesson
    // description field.
    if (l.notes_text) {
      sortOrder++;
      const notesOriginalName = `imfn-l${lnum}-notes.html`;
      if (existingNames.has(notesOriginalName)) {
        log(`  SKIP (already imported): Introduction to Mindfulness L${lnum} — Notes`);
        filesSkipped++;
      } else {
        try {
          const fixedHtml = `<article>${l.notes_text.replace(/src="\/wp-content\//g, 'src="https://deepermindfulness.org/wp-content/')}</article>`;
          const buffer = Buffer.from(fixedHtml, 'utf8');
          const key = `library/${crypto.randomUUID()}.html`;
          await media.putObject(key, buffer, 'text/html');
          const fileId = crypto.randomUUID();
          db.addLibraryFile(fileId, `Introduction to Mindfulness — ${l.title} Notes`,
            `Introduction to Mindfulness — ${l.title}, lesson notes.`,
            key, notesOriginalName, 'text/html', buffer.length,
            mindfulness.id, introSub ? introSub.id : null, 'member', 'r2', false, blogKind.value, null, null);
          db.addLessonFileRef(crypto.randomUUID(), lessonId, fileId, sortOrder, false);
          existingNames.add(notesOriginalName);
          log(`  OK: Introduction to Mindfulness L${lnum} — Notes (${(buffer.length/1024).toFixed(1)} KB)`);
          filesOk++;
        } catch (e) {
          log(`  FAILED: Introduction to Mindfulness L${lnum} — Notes — ${e.message}`);
          filesFailed++;
        }
      }
    }
  }

  log(`Done. ${filesOk} files imported, ${filesSkipped} already present, ${filesFailed} failed/skipped.`);
  return { courseId, filesOk, filesSkipped, filesFailed };
}

module.exports = { runImport };

if (require.main === module) {
  runImport().catch(e => { console.error(e); process.exit(1); });
}
