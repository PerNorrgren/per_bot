// ── Import: "Deeper Mindfulness" course (Per Bot 14) ──
// 8-lesson video course (Mark Williams / Danny Penman follow-on programme).
// Creates the course + 8 lessons under Mindfulness → Deeper Mindfulness,
// uploads every video, single practice audio, lesson notes, the Lesson 1
// handout (docx+pdf), and the extended 10/20/30-min practice-track sets
// (L1–L7 only — L7 confirmed to have no extended playlist) — all live-
// fetched from deepermindfulness.org, same as import_listen_and_learn.js.
//
// Corrections baked in from the WordPress export's messy duplicate/draft
// history (resolved with Per before this script was written):
//   - L2 Part 3: kept the correctly-spelled "Learning Points" video,
//     dropped the two misspelled duplicate drafts.
//   - L6 Part 1 / Part 2: video files were swapped in the source (titles
//     didn't match content) — corrected here.
//   - L6 "Dealing with the Difficult Practice" audio is a known gap: the
//     WordPress export has it pointing at the same file as "Befriending
//     Practice" (a duplicate, not a second real file). Per has the
//     original recording and will supply it separately — this script
//     SKIPS that one practice file until DM_L6_DEALING_PRACTICE_URL is
//     set (see below), rather than importing the wrong audio.
//   - L4 Part 3/4/5 title-vs-filename mapping is unresolved — Per is
//     reviewing separately. Imported as-is from the export; safe to
//     correct later via the admin lesson builder without re-running this
//     script.
//
// IN-PROCESS ONLY — sql.js keeps the whole DB in memory per process, so
// this must run inside the live server via the admin route in server.js,
// never as a separate `node` console process (race against the server's
// own save()).
//
// MUST run on Railway (or anywhere with real internet access) — fetches
// live URLs from deepermindfulness.org.
//
// Idempotent: skips any file already imported (matched by original_name),
// reuses the course/lessons/instance if they already exist.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const media = require('./media');

const MANIFEST_PATH = path.join(__dirname, 'deeper_mindfulness_import', 'dm_manifest.json');

const COURSE_TITLE = 'Deeper Mindfulness';
const COURSE_DESCRIPTION = 'Deeper Mindfulness – Going Beyond the Basics for True Inner Mastery. Developed from the approach in Finding Peace In a Frantic World (Mark Williams and Danny Penman), this eight-lesson course is the next step for anyone who has completed a mindfulness course or already keeps a regular practice — deepening awareness, balance, and inner peace beyond the basics.';

// Fill this in once Per supplies the original recording for the missing
// L6 practice, then re-run — the script will pick it up and import just
// that one file (everything else is already idempotent-skipped).
const DM_L6_DEALING_PRACTICE_URL = null;

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
  return {
    mp4: 'video/mp4', mp3: 'audio/mpeg', pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }[ext] || 'application/octet-stream';
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
  const deeperSub = db.getSubcategories(mindfulness.id).find(s => /deeper mindfulness/i.test(s.name));
  if (!deeperSub) throw new Error(`No "Deeper Mindfulness" subcategory found under Mindfulness. Available: ${db.getSubcategories(mindfulness.id).map(s=>`"${s.name}"`).join(', ')}`);

  // No generic "Video lesson" content kind exists yet (only "Course intro
  // video", which is a different thing) — create it once, idempotently,
  // rather than mis-filing every DM video under the intro kind.
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
  const whitepaperKind = kinds.find(k => /whitepaper/i.test(k.label));
  const otherKind = kinds.find(k => k.value === 'other');

  let course = db.getAllCourses().find(c => c.title === COURSE_TITLE);
  let courseId;
  if (course) {
    courseId = course.id;
    log(`Course "${COURSE_TITLE}" already exists — reusing (id ${courseId}).`);
  } else {
    courseId = crypto.randomUUID();
    db.createCourse(courseId, COURSE_TITLE, COURSE_DESCRIPTION, mindfulness.id, deeperSub.id, false, null);
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
        mindfulness.id, deeperSub.id, 'member', 'r2', false, contentType, null, null);
      db.addLessonFileRef(crypto.randomUUID(), lessonId, fileId, sortOrder, !!mandatory);

      existingNames.add(originalName);
      log(`  OK: ${title} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
      filesOk++;
    } catch (e) {
      log(`  FAILED: ${title} — ${e.message}`);
      filesFailed++;
    }
  }

  // Intro (lesson 0) — no media in the export, but the body text is a
  // real course-overview write-up, not a short blurb — same file-not-
  // description reasoning as the per-lesson notes below.
  if (manifest.intro) {
    let introLesson = existingLessons.find(l => l.lesson_number === 0);
    let introId;
    if (introLesson) {
      introId = introLesson.id;
      log('Lesson 0 (Introduction) already exists — reusing.');
    } else {
      introId = crypto.randomUUID();
      db.createLesson(introId, courseId, 0, 'Introduction', '', 'member');
      log('Created Lesson 0: Introduction.');
    }
    const introOriginalName = 'dm-l0-intro.html';
    if (existingNames.has(introOriginalName)) {
      log('  SKIP (already imported): Deeper Mindfulness — Introduction');
      filesSkipped++;
    } else if (manifest.intro.body) {
      try {
        const fixedHtml = `<article>${manifest.intro.body.replace(/src="\/wp-content\//g, 'src="https://deepermindfulness.org/wp-content/')}</article>`;
        const buffer = Buffer.from(fixedHtml, 'utf8');
        const key = `library/${crypto.randomUUID()}.html`;
        await media.putObject(key, buffer, 'text/html');
        const fileId = crypto.randomUUID();
        db.addLibraryFile(fileId, 'Deeper Mindfulness — Introduction',
          'Deeper Mindfulness — course introduction.',
          key, introOriginalName, 'text/html', buffer.length,
          mindfulness.id, deeperSub.id, 'member', 'r2', false,
          (kinds.find(k => /blog/i.test(k.label)) || otherKind).value, null, null);
        db.addLessonFileRef(crypto.randomUUID(), introId, fileId, 1, false);
        existingNames.add(introOriginalName);
        log(`  OK: Deeper Mindfulness — Introduction (${(buffer.length/1024).toFixed(1)} KB)`);
        filesOk++;
      } catch (e) {
        log(`  FAILED: Deeper Mindfulness — Introduction — ${e.message}`);
        filesFailed++;
      }
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

    // Videos — mandatory (the core teaching content for this course).
    for (const v of l.videos) {
      sortOrder++;
      const originalName = `dm-l${lnum}-video-${v.wp_id}-${(v.url||'').split('/').pop()}`;
      await importFile({
        url: v.url, originalName, title: `Deeper Mindfulness L${lnum} — ${v.label}`,
        description: `Deeper Mindfulness — Lesson ${lnum}, ${v.label}.`,
        contentType: videoKind.value, mandatory: true, lessonId, sortOrder,
      });
    }

    // Practice audio(s) — mandatory (the assigned homework practice).
    for (const p of l.practices) {
      sortOrder++;
      let url = p.url;
      if (p.placeholder && !url) {
        if (lnum === 6 && /dealing with the difficult/i.test(p.label) && DM_L6_DEALING_PRACTICE_URL) {
          url = DM_L6_DEALING_PRACTICE_URL;
        } else {
          log(`  SKIP (${p.placeholder}): ${p.label}`);
          filesFailed++;
          continue;
        }
      }
      const originalName = `dm-l${lnum}-practice-${p.wp_id}-${(url||'').split('/').pop()}`;
      await importFile({
        url, originalName, title: `Deeper Mindfulness L${lnum} — ${p.label}`,
        description: `Deeper Mindfulness — Lesson ${lnum} practice audio.`,
        contentType: meditationKind.value, mandatory: true, lessonId, sortOrder,
      });
    }

    // Lesson notes — a full blog-style write-up plus a header image plus
    // a closing poem (same content as the original WordPress course
    // page), NOT short text. lessons.description is only ever shown as a
    // small blurb above the file-choice buttons, so this must go in as
    // its own text/html library file instead — same pattern as the
    // Being Here poems, rendered properly in the player overlay rather
    // than dumped as an oversized, unstyled, image-broken blurb.
    if (l.notes_text) {
      sortOrder++;
      const notesOriginalName = `dm-l${lnum}-notes.html`;
      if (existingNames.has(notesOriginalName)) {
        log(`  SKIP (already imported): Deeper Mindfulness L${lnum} — Notes`);
        filesSkipped++;
      } else {
        try {
          const fixedHtml = `<article>${l.notes_text.replace(/src="\/wp-content\//g, 'src="https://deepermindfulness.org/wp-content/')}</article>`;
          const buffer = Buffer.from(fixedHtml, 'utf8');
          const key = `library/${crypto.randomUUID()}.html`;
          await media.putObject(key, buffer, 'text/html');
          const fileId = crypto.randomUUID();
          db.addLibraryFile(fileId, `Deeper Mindfulness — ${l.title} Notes`,
            `Deeper Mindfulness — ${l.title}, lesson notes and reflection poem.`,
            key, notesOriginalName, 'text/html', buffer.length,
            mindfulness.id, deeperSub.id, 'member', 'r2', false,
            (kinds.find(k => /blog/i.test(k.label)) || otherKind).value, null, null);
          db.addLessonFileRef(crypto.randomUUID(), lessonId, fileId, sortOrder, false);
          existingNames.add(notesOriginalName);
          log(`  OK: Deeper Mindfulness L${lnum} — Notes (${(buffer.length/1024).toFixed(1)} KB)`);
          filesOk++;
        } catch (e) {
          log(`  FAILED: Deeper Mindfulness L${lnum} — Notes — ${e.message}`);
          filesFailed++;
        }
      }
    }

    // Handout (Lesson 1 only) — optional supplementary reading. Both
    // formats (docx + pdf) import as separate files, so the title needs
    // to say which is which — two identically-titled "Handout" entries
    // in the lesson chooser gives no way to tell them apart.
    if (l.handout) {
      for (const fname of l.handout) {
        sortOrder++;
        const ext = fname.split('.').pop().toUpperCase();
        const url = `https://deepermindfulness.org/wp-content/uploads/2025/01/${fname}`;
        await importFile({
          url, originalName: `dm-l${lnum}-handout-${fname}`, title: `Deeper Mindfulness L${lnum} — Handout (${ext})`,
          description: `Deeper Mindfulness — Lesson ${lnum} handout.`,
          contentType: (whitepaperKind || otherKind).value, mandatory: false, lessonId, sortOrder,
        });
      }
    }

    // Extended practice tracks (10/20/30-min variants etc.) — optional
    // bonus material, not part of the mandatory completion count.
    for (const t of l.extended_tracks) {
      sortOrder++;
      const originalName = `dm-l${lnum}-extra-${(t.url||'').split('/').pop()}`;
      await importFile({
        url: t.url, originalName, title: `Deeper Mindfulness L${lnum} — ${t.label}`,
        description: `Deeper Mindfulness — Lesson ${lnum} extended practice track.`,
        contentType: meditationKind.value, mandatory: false, lessonId, sortOrder,
      });
    }
  }

  log(`Done. ${filesOk} files imported, ${filesSkipped} already present, ${filesFailed} failed/skipped.`);
  return { courseId, filesOk, filesSkipped, filesFailed };
}

module.exports = { runImport };

if (require.main === module) {
  runImport().catch(e => { console.error(e); process.exit(1); });
}
