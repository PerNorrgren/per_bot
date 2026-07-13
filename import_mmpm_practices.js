// ── Import: MMPM practice audio library (Per Bot 14) ──
// The ~50 unattached MMPM practice tracks found in the WordPress export
// while scoping the Introduction to Micro Moves course — never linked
// into any lesson there, just sitting in the media library. Imported
// here as standalone Content Library files (not attached to any course
// or lesson), auto-tagged by theme from their filenames, and marked
// Featured so they populate the themed practice shelves on the client
// Home screen straight away.
//
// Deduped from the raw export (46 → 44): a couple of files were
// re-uploaded to WordPress under an auto-suffixed name (e.g. "...-1.mp3")
// with identical content — only one copy of each imported.
//
// Theme tagging is a best-effort keyword classification from each file's
// title/filename, reusing Per's existing theme vocabulary (grounding,
// sleep, difficulty, pain, relax, focus, self-compassion, self-worth,
// decentering, appreciation, pleasant) where it fits, plus a few
// genuinely distinct themes not in that list (arousal, uncertainty,
// motivation) rather than forcing a bad fit. Nothing here is precise —
// worth a pass in Admin's new tagging UI to correct anything off, now
// that it exists to do that with.
//
// IN-PROCESS ONLY — sql.js keeps the whole DB in memory per process, so
// this must run inside the live server via the admin route in server.js.
//
// MUST run on Railway — fetches live URLs from deepermindfulness.org.
//
// Idempotent: skips any file already imported (matched by original_name).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const media = require('./media');

const MANIFEST_PATH = path.join(__dirname, 'mmpm_practices_import', 'mmpm_practices_manifest.json');

async function fetchBuffer(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch failed: HTTP ${resp.status} — ${url}`);
  return Buffer.from(await resp.arrayBuffer());
}

// Turns "MMPM - Grounding after stressful encounter 7min" into a cleaner
// display title — drops the "MMPM"/"MMPM -" prefix noise, keeps the rest.
function cleanTitle(raw) {
  return raw.replace(/^mmpm\s*-?\s*/i, '').trim() || raw;
}

async function runImport(log = console.log) {
  if (!media.isConfigured()) {
    throw new Error('R2 is not configured — missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY.');
  }
  if (!fs.existsSync(MANIFEST_PATH)) throw new Error(`Manifest not found at ${MANIFEST_PATH}.`);

  await db.getDb();

  const categories = db.getAllCategories();
  const mindfulness = categories.find(c => !c.parent_id && /^mindfulness$/i.test(c.name));
  if (!mindfulness) throw new Error(`No top-level "Mindfulness" category found.`);

  const kinds = db.getAllContentKinds();
  const meditationKind = kinds.find(k => /meditation/i.test(k.label));
  if (!meditationKind) throw new Error('No "Practice / meditation" content kind found.');

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const existingFiles = db.getLibraryFiles({ categoryId: mindfulness.id }) || [];
  const existingNames = new Set(existingFiles.map(f => f.original_name));

  let filesOk = 0, filesSkipped = 0, filesFailed = 0, tagsApplied = 0;

  for (const item of manifest) {
    const originalName = `mmpm-practice-${item.filename}`;
    const title = cleanTitle(item.title);
    if (existingNames.has(originalName)) {
      log(`  SKIP (already imported): ${title}`);
      filesSkipped++;
      continue;
    }
    try {
      const buffer = await fetchBuffer(item.url);
      const key = `library/${crypto.randomUUID()}.mp3`;
      await media.putObject(key, buffer, 'audio/mpeg');

      const fileId = crypto.randomUUID();
      db.addLibraryFile(fileId, title, 'Micro-moves practice audio.', key, originalName, 'audio/mpeg', buffer.length,
        mindfulness.id, null, 'member', 'r2', false, meditationKind.value, null, null);
      db.updateLibraryFile(fileId, { featured: 1 });
      (item.tags || []).forEach(tag => { db.addFileTag(fileId, tag); tagsApplied++; });

      existingNames.add(originalName);
      log(`  OK: ${title} (${(buffer.length / 1024 / 1024).toFixed(1)} MB) — tags: ${(item.tags || []).join(', ')}`);
      filesOk++;
    } catch (e) {
      log(`  FAILED: ${title} — ${e.message}`);
      filesFailed++;
    }
  }

  log(`Done. ${filesOk} files imported (${tagsApplied} tags applied), ${filesSkipped} already present, ${filesFailed} failed.`);
  return { filesOk, filesSkipped, filesFailed, tagsApplied };
}

module.exports = { runImport };

if (require.main === module) {
  runImport().catch(e => { console.error(e); process.exit(1); });
}
