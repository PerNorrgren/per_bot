// ── Import: standalone poems (Per Bot 14) ──
// 161 published WordPress posts categorized "Poems" — separate from the
// 84 poems used inside the Being Here course (those are filed under a
// different content type, "Course Material", specifically so they
// wouldn't collide with this general library; see
// import_being_here_course.js). Some titles here may still read as
// similar to Being Here's course poems if the same piece was reused in
// both places — easy to archive any real duplicates once they're
// visible in Content Library, not something worth trying to guess-match
// automatically here.
//
// Filed under Writing → Poems if that category exists (per the Per Bot
// 13 handover, which describes filing content there) — falls back to
// the Mindfulness top-level category with no subcategory if "Writing"
// doesn't exist in this deployment, rather than failing outright or
// silently inventing a category structure.
//
// Titles get their redundant "– Per Norrgren" / "- Per Norrgren" suffix
// stripped for display — every title here has it baked in, and it reads
// as clutter rather than a byline in a list of cards.
//
// IN-PROCESS ONLY — sql.js keeps the whole DB in memory per process, so
// this must run inside the live server via the admin route in server.js.
//
// Idempotent: skips any poem already imported (matched by original_name).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const media = require('./media');

const MANIFEST_PATH = path.join(__dirname, 'standalone_poems_import', 'poems_manifest.json');

function cleanTitle(raw) {
  return raw.replace(/\s*[-–—]\s*Per Norrgren\s*$/i, '').trim() || raw;
}

async function runImport(log = console.log) {
  if (!media.isConfigured()) {
    throw new Error('R2 is not configured — missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY.');
  }
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`Manifest not found at ${MANIFEST_PATH}.`);

  await db.getDb();

  const categories = db.getAllCategories();
  let topCat = categories.find(c => !c.parent_id && /^writing$/i.test(c.name));
  let subCat = null;
  if (topCat) {
    subCat = db.getSubcategories(topCat.id).find(s => /poems?/i.test(s.name)) || null;
    log(`Filing under "${topCat.name}"${subCat ? ` → "${subCat.name}"` : ' (no "Poems" subcategory found — filed with no subcategory)'}.`);
  } else {
    topCat = categories.find(c => !c.parent_id && /^mindfulness$/i.test(c.name));
    if (!topCat) throw new Error(`No "Writing" or "Mindfulness" top-level category found. Available: ${categories.filter(c=>!c.parent_id).map(c=>`"${c.name}"`).join(', ')}`);
    log(`No "Writing" category found — filed under "${topCat.name}" with no subcategory instead. Worth moving these once a proper Writing/Poems category exists.`);
  }

  const kinds = db.getAllContentKinds();
  const poemKind = kinds.find(k => k.value === 'poem');
  if (!poemKind) throw new Error('No "Poem" content kind found.');

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const existingFiles = db.getLibraryFiles({ categoryId: topCat.id }) || [];
  const existingNames = new Set(existingFiles.map(f => f.original_name));

  let filesOk = 0, filesSkipped = 0, filesFailed = 0;

  for (const poem of manifest) {
    const originalName = `standalone-poem-${poem.wp_id}.html`;
    const title = cleanTitle(poem.title);
    if (existingNames.has(originalName)) {
      log(`  SKIP (already imported): ${title}`);
      filesSkipped++;
      continue;
    }
    try {
      const html = `<article>${poem.body}</article>`;
      const buffer = Buffer.from(html, 'utf8');
      const key = `library/${crypto.randomUUID()}.html`;
      await media.putObject(key, buffer, 'text/html');

      const fileId = crypto.randomUUID();
      db.addLibraryFile(fileId, title, '', key, originalName, 'text/html', buffer.length,
        topCat.id, subCat ? subCat.id : null, 'member', 'r2', false, poemKind.value, null, null);

      existingNames.add(originalName);
      log(`  OK: ${title}`);
      filesOk++;
    } catch (e) {
      log(`  FAILED: ${title} — ${e.message}`);
      filesFailed++;
    }
  }

  log(`Done. ${filesOk} poems imported, ${filesSkipped} already present, ${filesFailed} failed.`);
  return { filesOk, filesSkipped, filesFailed };
}

module.exports = { runImport };

if (require.main === module) {
  runImport().catch(e => { console.error(e); process.exit(1); });
}
