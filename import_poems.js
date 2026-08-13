// ── Poems for the Soul import (Per Bot 39) ── One-time. Per uploaded his
// "Poems for the Soul 2026" collection (119 poems total) and asked for it
// to go straight into the library. Cross-checked every title in the
// document against what's already in the library first (normalizing
// away the "Poem - " prefix and punctuation differences) — 51 of the 119
// turned out to already be there from an earlier import, so this
// manifest (poems_import/poems_manifest.json) only contains the 68
// genuinely new ones, each with its title (in the existing "Poem - X"
// convention) and its body already converted to the same simple
// <p>...<br/>...</p>-per-stanza HTML the rest of the poem library uses.
// A stray "-Per Norrgren" author line directly under the title (present
// on some but not all poems in the source doc) was stripped during
// extraction, and the final poem's body was cut off before the
// document's own "Thank You" back-matter section, which isn't a real
// heading in the source file and would otherwise have been swept in.
//
// Every new poem lands in Writing > Poems (the same category/subcategory
// every existing poem already uses) at Member visibility, matching the
// existing poems' own visibility. Re-checks the live library by title
// each time it runs (not just against the one-time manifest snapshot),
// so running this twice — or after some of these titles get added some
// other way in the meantime — skips rather than duplicates.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const media = require('./media');

const MANIFEST_PATH = path.join(__dirname, 'poems_import', 'poems_manifest.json');
const WRITING_CATEGORY_ID = '6d73604b-f1b1-4287-90e9-7f1ba28759a5';
const POEMS_SUBCATEGORY_ID = 'f14eec5f-6afe-4247-8168-0ff97ea0d785';

function norm(t) {
  return t.toLowerCase().replace(/^poem\s*[-–—]\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function runImport(log) {
  if (!media.isConfigured()) {
    throw new Error('R2 storage is not configured on this deployment — cannot upload poem content.');
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  log(`Loaded ${manifest.length} new poems from poems_manifest.json.`);

  const existing = db.getLibraryFiles({ contentType: 'poem' }) || [];
  const existingNorm = new Set(existing.map(f => norm(f.title)));

  let created = 0, skippedExisting = 0, failed = 0;
  for (const entry of manifest) {
    const n = norm(entry.title);
    if (existingNorm.has(n)) {
      skippedExisting++;
      log(`  SKIP (already in library): ${entry.title}`);
      continue;
    }
    try {
      const id = crypto.randomUUID();
      const key = `library/${crypto.randomUUID()}.html`;
      const buffer = Buffer.from(entry.html, 'utf-8');
      await media.putObject(key, buffer, 'text/html');
      db.addLibraryFile(
        id, entry.title, '', key, `${entry.title}.html`,
        'text/html', buffer.length, WRITING_CATEGORY_ID, POEMS_SUBCATEGORY_ID,
        'member', 'r2', false, 'poem', null, null
      );
      existingNorm.add(n); // guards against duplicate titles within the manifest itself
      created++;
      log(`  Added: ${entry.title}`);
    } catch (e) {
      failed++;
      log(`  FAILED: ${entry.title} — ${e.message}`);
    }
  }

  const result = { totalInManifest: manifest.length, created, skippedExisting, failed };
  log(`Done. Added: ${created}. Already in library: ${skippedExisting}. Failed: ${failed}.`);
  return result;
}

module.exports = { runImport };
