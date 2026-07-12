// ── Fix: Deeper Mindfulness lesson notes rendering (Per Bot 14) ──
//
// The DM import stored each lesson's full "Lesson Notes" content (a long
// blog-style write-up plus a header image plus a closing poem — the same
// rich content visible on the original WordPress course page) directly
// into lessons.description. That field is only ever shown as a short
// blurb ABOVE the file-choice buttons in the multi-file lesson chooser —
// never as its own readable page — so in practice it just dumped several
// thousand characters of unstyled text into that small space, with a
// broken image (relative WordPress path, wrong domain).
//
// The correct pattern — already used for the 84 Being Here poems — is a
// text/html library file, fetched and rendered inline in the player
// overlay via the app's own styling (see openContentFile's 'text/html'
// branch in public/client/index.html), linked into the lesson like any
// other file (optional, not mandatory — supplementary reading, not the
// core teaching, same as the DM handout).
//
// This script: wraps each lesson's stored notes HTML in <article>...
// </article> (what the client's HTML renderer looks for), rewrites the
// relative image src to an absolute deepermindfulness.org URL (works
// today; flagged as fragile once the domain cutover happens — see the
// Per Bot 14 handover), uploads it as a new library file, links it into
// the lesson, and clears the lesson's description field back to empty.
//
// IN-PROCESS ONLY, idempotent — same reasoning as every other import/fix
// script this session. Safe to re-run: skips any lesson whose notes file
// has already been created (matched by original_name), and only clears
// lessons.description if it still has the old dumped content.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const media = require('./media');

const MANIFEST_PATH = path.join(__dirname, 'deeper_mindfulness_import', 'dm_manifest.json');
const COURSE_TITLE = 'Deeper Mindfulness';
const WP_BASE = 'https://deepermindfulness.org';

function absolutizeImages(html) {
  return html.replace(/src="\/wp-content\//g, `src="${WP_BASE}/wp-content/`);
}

async function runFix(log = console.log) {
  if (!media.isConfigured()) throw new Error('R2 is not configured.');
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`Manifest not found at ${MANIFEST_PATH}.`);

  await db.getDb();

  const categories = db.getAllCategories();
  const mindfulness = categories.find(c => !c.parent_id && /^mindfulness$/i.test(c.name));
  const deeperSub = db.getSubcategories(mindfulness.id).find(s => /deeper mindfulness/i.test(s.name));

  const kinds = db.getAllContentKinds();
  const blogKind = kinds.find(k => /blog/i.test(k.label)) || kinds.find(k => k.value === 'other');

  const course = db.getAllCourses().find(c => c.title === COURSE_TITLE);
  if (!course) throw new Error(`Course "${COURSE_TITLE}" not found — run the import first.`);
  const lessons = db.getLessonsForCourse(course.id);

  const existingFiles = db.getLibraryFiles({ categoryId: mindfulness.id }) || [];
  const existingNames = new Set(existingFiles.map(f => f.original_name));

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  let ok = 0, skipped = 0, failed = 0;

  async function moveNotesToFile(lessonNumber, rawHtml, lessonTitle) {
    const lesson = lessons.find(l => l.lesson_number === lessonNumber);
    if (!lesson) { log(`  SKIP (lesson ${lessonNumber} not found)`); skipped++; return; }
    const originalName = `dm-l${lessonNumber}-notes.html`;
    if (existingNames.has(originalName)) {
      log(`  SKIP (already fixed): Lesson ${lessonNumber} notes`);
      skipped++;
    } else {
      try {
        const fixedHtml = `<article>${absolutizeImages(rawHtml)}</article>`;
        const buffer = Buffer.from(fixedHtml, 'utf8');
        const key = `library/${crypto.randomUUID()}.html`;
        await media.putObject(key, buffer, 'text/html');

        const fileId = crypto.randomUUID();
        db.addLibraryFile(fileId, `Deeper Mindfulness — ${lessonTitle} Notes`,
          `Deeper Mindfulness — ${lessonTitle}, lesson notes and reflection poem.`,
          key, originalName, 'text/html', buffer.length,
          mindfulness.id, deeperSub.id, 'member', 'r2', false, blogKind.value, null, null);

        // Sort last within the lesson — supplementary reading, after the
        // core teaching (videos, practice, handout).
        const filesInLesson = db.getFilesForLesson(lesson.id);
        const nextSort = (filesInLesson.reduce((max, f) => Math.max(max, f.sort_order || 0), 0)) + 1;
        db.addLessonFileRef(crypto.randomUUID(), lesson.id, fileId, nextSort, false);

        existingNames.add(originalName);
        log(`  OK: Lesson ${lessonNumber} notes moved to its own file (${(buffer.length/1024).toFixed(1)} KB)`);
        ok++;
      } catch (e) {
        log(`  FAILED: Lesson ${lessonNumber} notes — ${e.message}`);
        failed++;
        return;
      }
    }

    // Clear the old dumped content out of the description, whether or not
    // this run just created the file (covers a re-run after a partial
    // failure elsewhere) — only touches it if it still looks like the old
    // dump, so a legitimately-edited short description isn't clobbered.
    if (lesson.description && lesson.description.length > 500) {
      db.updateLesson(lesson.id, lesson.lesson_number, lesson.title, '', lesson.visibility);
      log(`  Cleared oversized description on Lesson ${lessonNumber}.`);
    }
  }

  if (manifest.intro && manifest.intro.body) {
    await moveNotesToFile(0, manifest.intro.body, 'Introduction');
  }
  for (let lnum = 1; lnum <= 8; lnum++) {
    const l = manifest[String(lnum)];
    if (l && l.notes_text) {
      await moveNotesToFile(lnum, l.notes_text, l.title);
    }
  }

  log(`Done. ${ok} notes files created, ${skipped} already fixed, ${failed} failed.`);
  return { ok, skipped, failed };
}

module.exports = { runFix };

if (require.main === module) {
  runFix().catch(e => { console.error(e); process.exit(1); });
}
