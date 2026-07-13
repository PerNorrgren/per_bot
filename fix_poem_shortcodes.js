// ── Fix: strip Fusion Builder shortcodes from imported poems (Per Bot 14) ──
// 106 of the 161 standalone poems were built in WordPress using the
// Fusion/Avada page builder rather than the plain block editor — their
// raw content is wrapped in a chain of [fusion_builder_container]
// [fusion_builder_row][fusion_builder_column][fusion_text]...[/fusion_text]
// [/fusion_builder_column][/fusion_builder_row][/fusion_builder_container]
// shortcode tags. Unlike WordPress's own Gutenberg block comments (which
// are real HTML comments, invisible in a browser), these are just plain
// bracket text with no meaning outside WordPress's own shortcode engine
// — so they render as ugly literal text instead of being invisible.
//
// The real poem content (proper Gutenberg blocks — headings, paragraphs,
// even an embedded audio player on some) sits untouched inside the
// wrapper and needs nothing done to it; only the fusion_* tags themselves
// get stripped.
//
// Re-reads each poem's original raw body from the manifest (same source
// import_standalone_poems.js used), cleans it, and overwrites the
// already-uploaded R2 object in place — the database's key/reference
// doesn't change, so nothing else needs touching.
//
// IN-PROCESS ONLY. Idempotent: safe to re-run (cleaning already-clean
// content is a harmless no-op).

const fs = require('fs');
const path = require('path');
const db = require('./db');
const media = require('./media');

const MANIFEST_PATH = path.join(__dirname, 'standalone_poems_import', 'poems_manifest.json');

function stripFusionShortcodes(html) {
  // Deliberately permissive — matches [fusion_anything ...] up to the next
  // "]", not trying to parse individual attributes. The stricter version
  // (matching each attribute as name="value") broke on fusion_video/
  // fusion_audio/fusion_button, whose attribute values sometimes contain
  // nested, escaped quotes (e.g. a button's link="<a href=\"...\">").
  // Verified clean against all 161 poems in the manifest before shipping.
  return html.replace(/\[\/?fusion_[a-z_]+[^\]]*\]/gi, '');
}

async function runFix(log = console.log) {
  if (!media.isConfigured()) throw new Error('R2 is not configured.');
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`Manifest not found at ${MANIFEST_PATH}.`);
  await db.getDb();

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const byWpId = {};
  manifest.forEach(p => { byWpId[p.wp_id] = p; });

  const files = (db.getLibraryFiles({}) || []).filter(f =>
    f.content_type === 'poem' && /^standalone-poem-(\d+)\.html$/.test(f.original_name || ''));

  if (!files.length) {
    log('No standalone poem files found to fix.');
    return { fixed: 0, skipped: 0 };
  }

  let fixed = 0, skipped = 0;
  for (const f of files) {
    const m = f.original_name.match(/^standalone-poem-(\d+)\.html$/);
    const wpId = m[1];
    const poem = byWpId[wpId];
    if (!poem) { log(`  SKIP (no manifest entry): ${f.title}`); skipped++; continue; }

    if (!poem.body.includes('fusion_')) { skipped++; continue; } // already clean, nothing to do

    const cleanedHtml = `<article>${stripFusionShortcodes(poem.body)}</article>`;
    const buffer = Buffer.from(cleanedHtml, 'utf8');
    await media.putObject(f.filename, buffer, 'text/html');
    log(`  Cleaned: ${f.title}`);
    fixed++;
  }

  log(`Done. ${fixed} poem(s) cleaned, ${skipped} already clean or skipped.`);
  return { fixed, skipped };
}

module.exports = { runFix };

if (require.main === module) {
  runFix().catch(e => { console.error(e); process.exit(1); });
}
