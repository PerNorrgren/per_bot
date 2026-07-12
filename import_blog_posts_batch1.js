// ── Import: WordPress blog posts, batch 1 (Per Bot 13) ──
// Uploads the reviewed/cleaned HTML files in ./blog_import/html to R2,
// creates one library_files row per file (content_kind 'blog' or
// 'whitepaper'), filed under Writing → Blog (or Writing → Whitepapers),
// and tags each one with its suggested theme(s) from import_manifest.json
// via the library_file_tags table.
//
// IMPORTANT: this must run IN-PROCESS on the live server, not as a separate
// `node import_blog_posts_batch1.js` console script. sql.js keeps the whole
// database in memory per-process and save() does a full overwrite of the
// file — running this as a standalone process creates a race with the
// already-running server's own in-memory copy, and the next save() from the
// live server silently wipes out whatever this script wrote. See the admin
// route in server.js (POST /api/admin/run-blog-import-batch1) which calls
// runImport() below directly, sharing the server's own db singleton.
//
// Idempotent by design: skips any entry whose original_name already exists
// as a library_files row, so it's safe to call more than once (e.g. after a
// partial failure) without creating duplicates.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const media = require('./media');

const IMPORT_DIR = path.join(__dirname, 'blog_import');
const HTML_DIR = path.join(IMPORT_DIR, 'html');
const MANIFEST_PATH = path.join(IMPORT_DIR, 'import_manifest.json');

async function runImport(log = console.log) {
  if (!media.isConfigured()) {
    throw new Error('R2 is not configured — missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY.');
  }
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found at ${MANIFEST_PATH}. Is ./blog_import/ deployed?`);
  }

  await db.getDb();

  const categories = db.getAllCategories();
  const writing = categories.find(c => c.name.toLowerCase() === 'writing' && !c.parent_id);
  if (!writing) throw new Error('No top-level "Writing" category found. Create it in Admin → Categories first.');

  const subs = db.getSubcategories(writing.id);
  const blogSub = subs.find(s => s.name.toLowerCase() === 'blog');
  const whitepaperSub = subs.find(s => s.name.toLowerCase() === 'whitepapers');
  if (!blogSub) throw new Error('No "Blog" subcategory found under Writing. Create it in Admin → Categories first.');
  if (!whitepaperSub) log('No "Whitepapers" subcategory found under Writing — whitepaper-flagged posts will be filed under Blog instead.');

  // Existing titles already filed under Writing, for the idempotency check.
  const existing = db.getLibraryFiles({ categoryId: writing.id }) || [];
  const existingNames = new Set(existing.map(f => f.original_name));

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  log(`Importing ${manifest.length} posts...`);

  let ok = 0, failed = 0, skipped = 0;
  const results = [];

  for (const entry of manifest) {
    if (existingNames.has(entry.filename)) {
      log(`  SKIP (already imported): ${entry.title}`);
      skipped++;
      continue;
    }
    const filePath = path.join(HTML_DIR, entry.filename);
    if (!fs.existsSync(filePath)) {
      log(`  SKIP (file missing): ${entry.filename}`);
      failed++;
      continue;
    }
    try {
      const buffer = fs.readFileSync(filePath);
      const key = `library/${crypto.randomUUID()}.html`;
      await media.putObject(key, buffer, 'text/html');

      const isWhitepaper = entry.content_kind === 'whitepaper';
      const subcategoryId = isWhitepaper && whitepaperSub ? whitepaperSub.id : blogSub.id;
      const contentKind = isWhitepaper ? 'whitepaper' : 'blog';

      const id = crypto.randomUUID();
      db.addLibraryFile(
        id,
        entry.title,
        `Originally published ${entry.date.slice(0, 10)} on deepermindfulness.org.`,
        key,
        entry.filename,
        'text/html',
        buffer.length,
        writing.id,
        subcategoryId,
        'client',
        'r2',
        false,
        contentKind,
        null,
        null
      );

      (entry.suggested_tags || []).forEach(tag => db.addFileTag(id, tag));

      log(`  OK: ${entry.title}  [${contentKind}]  tags: ${(entry.suggested_tags || []).join(', ') || '(none)'}`);
      results.push({ title: entry.title, id, contentKind });
      ok++;
    } catch (e) {
      log(`  FAILED: ${entry.title} — ${e.message}`);
      failed++;
    }
  }

  log(`Done. ${ok} imported, ${skipped} already present, ${failed} failed/skipped.`);
  return { ok, skipped, failed, results };
}

module.exports = { runImport };

// Still runnable standalone for local testing against a throwaway db copy —
// NOT for use against the live production database (see warning above).
if (require.main === module) {
  runImport().catch(e => { console.error(e); process.exit(1); });
}
