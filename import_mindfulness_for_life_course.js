// ── Import: "Mindfulness For Life" course (Per Bot 14) ──
// 8-lesson video course. Creates the course + 8 lessons under Mindfulness
// → Mindfulness for Life, uploads every video, practice audio, and lesson
// notes text — live-fetched from deepermindfulness.org, same pattern as
// import_deeper_mindfulness_course.js.
//
// Unlike DM, MFL has no extended 10/20/30-min track variants (its one
// aggregator playlist, L1, just re-lists the same three practices already
// imported individually — not imported separately here to avoid dupes),
// and no handout.
//
// Corrections baked in from the WordPress export's duplicate/draft history:
//   - L2 "50/50 Practice": kept one of two identical duplicate entries.
//   - L3 practice track: one of its two src attributes was malformed
//     (missing a slash — "https:/wp-content/..."); normalised here.
//   - L3 "Befriending" draft entry (mistitled with an L3 prefix but
//     actually L5 content, and marked draft/stray in the export) excluded.
//   - L7 Part 1: two entries existed with the same title, one empty; kept
//     the one with an actual video file.
//
// Two things flagged but NOT auto-resolved — need Per's eyes, not a
// silent guess:
//   - L6 only has 2 video parts where every other lesson has 3 — may be
//     genuinely how it was recorded, or a missing Part 3 the export
//     didn't carry. Imported as-is.
//   - L6 and L7 Lesson Notes both had a stray, unrelated audio file
//     embedded in their WordPress content (looks like copy-paste bleed
//     from another page). Excluded from import — only the notes text
//     itself is stored, as the lesson description.
//
// IN-PROCESS ONLY — sql.js keeps the whole DB in memory per process, so
// this must run inside the live server via the admin route in server.js,
// never as a separate `node` console process.
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

const MANIFEST_PATH = path.join(__dirname, 'mindfulness_for_life_import', 'mfl_manifest.json');

const COURSE_TITLE = 'Mindfulness For Life';
const COURSE_DESCRIPTION = 'An eight-lesson mindfulness course working with the body, the breath, and the mind — from waking up out of autopilot through to a settled, sustainable practice you can carry forward on your own.';

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
  const mflSub = db.getSubcategories(mindfulness.id).find(s => /mindfulness for life/i.test(s.name));
  if (!mflSub) throw new Error(`No "Mindfulness for Life" subcategory found under Mindfulness. Available: ${db.getSubcategories(mindfulness.id).map(s=>`"${s.name}"`).join(', ')}`);

  // Reuse the "Video lesson" content kind created by the DM import — falls
  // back to creating it if this ever runs before that one has.
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

  let course = db.getAllCourses().find(c => c.title === COURSE_TITLE);
  let courseId;
  if (course) {
    courseId = course.id;
    log(`Course "${COURSE_TITLE}" already exists — reusing (id ${courseId}).`);
  } else {
    courseId = crypto.randomUUID();
    db.createCourse(courseId, COURSE_TITLE, COURSE_DESCRIPTION, mindfulness.id, mflSub.id, false, null);
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
        mindfulness.id, mflSub.id, 'member', 'r2', false, contentType, null, null);
      db.addLessonFileRef(crypto.randomUUID(), lessonId, fileId, sortOrder, !!mandatory);

      existingNames.add(originalName);
      log(`  OK: ${title} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
      filesOk++;
    } catch (e) {
      log(`  FAILED: ${title} — ${e.message}`);
      filesFailed++;
    }
  }

  for (let lnum = 1; lnum <= 8; lnum++) {
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
      const originalName = `mfl-l${lnum}-video-${v.wp_id}-${(v.url||'').split('/').pop()}`;
      await importFile({
        url: v.url, originalName, title: `Mindfulness For Life L${lnum} — ${v.label}`,
        description: `Mindfulness For Life — Lesson ${lnum}, ${v.label}.`,
        contentType: videoKind.value, mandatory: true, lessonId, sortOrder,
      });
    }

    for (const p of l.practices) {
      sortOrder++;
      const originalName = `mfl-l${lnum}-practice-${p.wp_id}-${(p.url||'').split('/').pop()}`;
      await importFile({
        url: p.url, originalName, title: `Mindfulness For Life L${lnum} — ${p.label}`,
        description: `Mindfulness For Life — Lesson ${lnum} practice audio.`,
        contentType: meditationKind.value, mandatory: true, lessonId, sortOrder,
      });
    }

    // Lesson notes — full blog-style write-up plus header image, same as
    // DM. lessons.description only ever shows as a small blurb above the
    // file-choice buttons, so this goes in as its own text/html library
    // file instead, rendered properly in the player overlay — same
    // pattern as the Being Here poems (corrected here after catching the
    // same mistake on the DM import; see Per Bot 14 handover).
    if (l.notes_text) {
      sortOrder++;
      const notesOriginalName = `mfl-l${lnum}-notes.html`;
      if (existingNames.has(notesOriginalName)) {
        log(`  SKIP (already imported): Mindfulness For Life L${lnum} — Notes`);
        filesSkipped++;
      } else {
        try {
          // A couple of lesson-notes pages (L6/L7) have a stray broken
          // <img> tag pointing at an .mp3 — copy-paste bleed from
          // WordPress, not real content. Stripped here rather than left
          // to render as a broken-image icon.
          let cleaned = l.notes_text
            .replace(/src="\/wp-content\//g, 'src="https://deepermindfulness.org/wp-content/')
            .replace(/<img[^>]*\.mp3[^>]*>/gi, '');
          const fixedHtml = `<article>${cleaned}</article>`;
          const buffer = Buffer.from(fixedHtml, 'utf8');
          const key = `library/${crypto.randomUUID()}.html`;
          await media.putObject(key, buffer, 'text/html');
          const fileId = crypto.randomUUID();
          db.addLibraryFile(fileId, `Mindfulness For Life — ${l.title} Notes`,
            `Mindfulness For Life — ${l.title}, lesson notes.`,
            key, notesOriginalName, 'text/html', buffer.length,
            mindfulness.id, mflSub.id, 'member', 'r2', false,
            (kinds.find(k => /blog/i.test(k.label)) || kinds.find(k => k.value === 'other')).value, null, null);
          db.addLessonFileRef(crypto.randomUUID(), lessonId, fileId, sortOrder, false);
          existingNames.add(notesOriginalName);
          log(`  OK: Mindfulness For Life L${lnum} — Notes (${(buffer.length/1024).toFixed(1)} KB)`);
          filesOk++;
        } catch (e) {
          log(`  FAILED: Mindfulness For Life L${lnum} — Notes — ${e.message}`);
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
