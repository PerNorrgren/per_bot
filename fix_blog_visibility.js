// ── Fix: blog/whitepaper visibility bug (Per Bot 14) ──
// The original blog import (Per Bot 13, import_blog_posts_batch1.js)
// hard-coded visibility='client' for every blog post and whitepaper.
// 'client' is a special one-to-one tier reserved for a person's actual
// assigned therapy client relationship — not appropriate for general
// content, and exactly why every blog post returned "Access denied" for
// anyone browsing normally. Moves them to 'member', matching how every
// other piece of general content in the library is gated.
//
// IN-PROCESS ONLY, idempotent — only touches rows that still have the
// bad value, safe to re-run.

const db = require('./db');

async function runFix(log = console.log) {
  await db.getDb();
  const files = db.getLibraryFiles({ includeArchived: true }) || [];
  const targets = files.filter(f =>
    (f.content_type === 'blog' || f.content_type === 'whitepaper') && f.visibility === 'client');

  if (!targets.length) {
    log('Nothing to fix — no blog/whitepaper files still have the bad visibility.');
    return { fixed: 0 };
  }

  targets.forEach(f => db.updateLibraryFile(f.id, { visibility: 'member' }));
  log(`Fixed ${targets.length} file(s): visibility 'client' → 'member'.`);
  targets.forEach(f => log(`  - ${f.title}`));
  return { fixed: targets.length };
}

module.exports = { runFix };

if (require.main === module) {
  runFix().catch(e => { console.error(e); process.exit(1); });
}
