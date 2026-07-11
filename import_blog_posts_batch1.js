// ── One-off import: WordPress blog posts, batch 1 (Per Bot 13) ──
// Uploads the 80 reviewed/cleaned HTML files in ./blog_import/html to R2,
// creates one library_files row per file (content_kind 'blog' or
// 'whitepaper'), filed under Writing → Blog (or Writing → Whitepapers),
// and tags each one with its suggested theme(s) from import_manifest.json
// via the new library_file_tags table.
//
// Safe to re-run: R2 keys are freshly generated uuids each run, but the
// category/subcategory lookup and tag inserts are idempotent — the only
// non-idempotent part is that re-running will create duplicate library_files
// rows (same as any other content upload), so don't run this twice without
// deleting the first batch from the admin panel first.
//
// BEFORE RUNNING: unzip blog_posts_batch1.zip into ./blog_import/ so this
// script finds ./blog_import/html/*.html and ./blog_import/import_manifest.json
// alongside it (or adjust IMPORT_DIR below).
//
// HOW TO RUN (Railway console tab, production — needs R2 env vars):
//   node import_blog_posts_batch1.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const media = require('./media');

const IMPORT_DIR = path.join(__dirname, 'blog_import');
const HTML_DIR = path.join(IMPORT_DIR, 'html');
const MANIFEST_PATH = path.join(IMPORT_DIR, 'import_manifest.json');

async function main() {
  if (!media.isConfigured()) {
    console.error('R2 is not configured — missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY. Run this on Railway production, not locally, unless your .env has these set.');
    process.exit(1);
  }
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`Manifest not found at ${MANIFEST_PATH}. Unzip blog_posts_batch1.zip into ./blog_import/ first.`);
    process.exit(1);
  }

  await db.getDb();

  const categories = db.getAllCategories();
  const writing = categories.find(c => c.name.toLowerCase() === 'writing' && !c.parent_id);
  if (!writing) {
    console.error('No top-level "Writing" category found. Create it in Admin → Categories first.');
    process.exit(1);
  }
  const subs = db.getSubcategories(writing.id);
  const blogSub = subs.find(s => s.name.toLowerCase() === 'blog');
  const whitepaperSub = subs.find(s => s.name.toLowerCase() === 'whitepapers');
  if (!blogSub) {
    console.error('No "Blog" subcategory found under Writing. Create it in Admin → Categories first.');
    process.exit(1);
  }
  if (!whitepaperSub) {
    console.warn('No "Whitepapers" subcategory found under Writing — whitepaper-flagged posts will be filed under Blog instead.');
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  console.log(`Importing ${manifest.length} posts...`);

  let ok = 0, failed = 0;

  for (const entry of manifest) {
    const filePath = path.join(HTML_DIR, entry.filename);
    if (!fs.existsSync(filePath)) {
      console.warn(`  SKIP (file missing): ${entry.filename}`);
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

      console.log(`  OK: ${entry.title}  [${contentKind}]  tags: ${(entry.suggested_tags || []).join(', ') || '(none)'}`);
      ok++;
    } catch (e) {
      console.error(`  FAILED: ${entry.title} — ${e.message}`);
      failed++;
    }
  }

  console.log(`\nDone. ${ok} imported, ${failed} failed/skipped.`);
}

main().catch(e => { console.error(e); process.exit(1); });
