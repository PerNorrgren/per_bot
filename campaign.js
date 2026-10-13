// campaign.js — Per App 38 (14): the weekly re-publishing campaign.
//
// Per's plan (13 Oct 2026): re-use the old blogs and poems, posting them
// again on social media on a schedule, and freshen each blog's public page
// just before its turn.
//
// Every Monday morning (UK time) this:
//  1. picks the next public blog in the queue (oldest first) and drafts a
//     fresh opening for it in Per's voice, plus a social post;
//  2. picks the next public poem and writes its social post (the poem itself
//     is never changed);
//  3. emails Per both, with Approve and Skip buttons.
// Nothing changes on the website until Per presses Approve. Approving
// replaces the blog's first paragraph with the new opening (the original
// file is kept under library-backup/campaign/ first), marks the page
// "Updated <date>", and refreshes its search entry. The social posts are
// for Per to post himself (or schedule in Social).
//
// Admin can also draft the next one straight away: POST /api/admin/campaign/draft-next.

const crypto = require('crypto');
const { parse } = require('node-html-parser');

const VOICE = `You write as Per Norrgren: an experienced mindfulness practitioner and teacher talking someone through it. Warm, direct, generous; never performing expertise or warmth.
- Start where the reader is: what they actually do and notice. Then name the puzzle they are in. No mood labels, no atmospheric or literary images.
- Explain simply, as to a client across the room. Images only if they explain, and they may be homely and a little funny.
- "We" carries the writing, "I" is the practitioner, "you" only when guiding. Never invent a client or a name.
- Plain words. Sentences may run on, joined with commas, as the thought moves. No lists of three, no "not X but Y", no tidy summing-up endings, no promises.
- Never: "It is worth noting", "Taken together", "In conclusion", "Let's dive in", "game-changer", "unlock", "journey", "transform your life".
- British spelling.`;

function mountCampaign(app, { db, media, publicPages, coursePages = [], callClaude, sendEmail, adminEmail, store, siteUrl, log = console.log }) {
  const SITE = String(siteUrl || 'https://deepermindfulness.org').replace(/\/+$/, '');
  let ready = false;
  function ensure() {
    if (ready) return;
    db.rawRun(`CREATE TABLE IF NOT EXISTS campaign_items (
      id TEXT PRIMARY KEY, file_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'drafted',
      old_opening TEXT, new_opening TEXT, social TEXT, token TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')), decided_at TEXT)`);
    ready = true;
  }
  const textOf = el => (el.text || '').replace(/\s+/g, ' ').trim();
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cleanTitle = t => String(t || '').replace(/^(blog|poem|whitepaper)\s*[-–:]?\s*/i, '').trim();

  async function readFile(f) {
    const obj = await media.getPublicObject(f.filename);
    const chunks = []; for await (const c of obj.Body) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString('utf8');
  }
  // The first real paragraph of the post (not the date line, not a promo
  // line, not a one-line heading in bold).
  function firstParagraph(article) {
    for (const p of article.querySelectorAll('p')) {
      const t = textOf(p);
      if (t.length < 60 || /^Originally published/i.test(t) || p.closest('.dm-links') || p.querySelector('a') && t.length < 100) continue;
      return p;
    }
    return null;
  }

  // Next in line: public, not done in the last 180 days, oldest first.
  function nextItem(kind) {
    ensure();
    const rows = publicPages.list().filter(r => r.published && r.kind === kind);
    const recent = new Set(db.rawAll(`SELECT file_id FROM campaign_items WHERE kind=? AND created_at > datetime('now', '-180 days')`, [kind]).map(r => r.file_id));
    const cand = rows.filter(r => !recent.has(r.file_id)).sort((a, b) => String(a.published_at || '9').localeCompare(String(b.published_at || '9')));
    return cand[0] || null;
  }

  async function draftBlog(row) {
    const f = db.getLibraryFile(row.file_id);
    const html = await readFile(f);
    const article = parse(html).querySelector('article') || parse(html);
    const first = firstParagraph(article);
    if (!first) throw new Error(`No opening paragraph found in "${f.title}".`);
    const following = [];
    let n = first.nextElementSibling;
    while (n && following.length < 4) { if (textOf(n)) following.push(textOf(n)); n = n.nextElementSibling; }
    const title = cleanTitle(f.title);
    const raw = await callClaude(VOICE,
      [{ role: 'user', content: `This blog post is going out again this week. Write two things and reply with JSON only: {"opening": "...", "social": "..."}.

"opening": a fresh opening paragraph to replace the current one (60 to 120 words). Keep what the post is about and how it continues; it must lead naturally into the paragraphs that follow. Plain text, no HTML.
"social": a social media post for it (60 to 120 words) that starts from the reader's experience, ends with an invitation to read the rest, and finishes with this link on its own line: ${SITE}/blog/${row.slug}

Title: ${title}
Current opening: ${textOf(first)}
What follows: ${following.join('\n')}` }], 900);
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('The draft came back without the expected format.');
    const j = JSON.parse(m[0]);
    if (!j.opening || !j.social) throw new Error('The draft came back incomplete.');
    return { old_opening: textOf(first), new_opening: String(j.opening).trim(), social: String(j.social).trim() };
  }

  async function poemPost(row) {
    const f = db.getLibraryFile(row.file_id);
    const article = parse(await readFile(f)).querySelector('article');
    const stanza = article ? (article.querySelectorAll('p').map(p => p.innerHTML.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim()).find(t => t.split('\n').length >= 2 && t.length > 40) || '') : '';
    return `${cleanTitle(f.title)}\n\n${stanza}\n\nRead the whole poem: ${SITE}/poems/${row.slug}`;
  }

  function saveItem(fileId, kind, d) {
    ensure();
    const id = crypto.randomUUID(), token = crypto.randomBytes(16).toString('hex');
    db.rawRun(`INSERT INTO campaign_items (id, file_id, kind, status, old_opening, new_opening, social, token) VALUES (?,?,?,?,?,?,?,?)`,
      [id, fileId, kind, kind === 'blog' ? 'drafted' : 'ready', d.old_opening || null, d.new_opening || null, d.social || null, token]);
    return { id, token };
  }

  async function draftWeek(trigger) {
    const out = {};
    const blog = nextItem('blog');
    if (blog) {
      const d = await draftBlog(blog);
      out.blog = { row: blog, d, ...saveItem(blog.file_id, 'blog', d) };
    }
    const poem = nextItem('poem');
    if (poem) {
      const social = await poemPost(poem);
      out.poem = { row: poem, social, ...saveItem(poem.file_id, 'poem', { social }) };
    }
    // Per App 38 (15) — every other week, a social post for the next course
    // page in turn (the course pages themselves are not changed).
    const st = store.getSettings();
    const runs = (st.campaignRuns || 0) + 1;
    if (coursePages.length && runs % 2 === 1) {
      const idx = (st.campaignCourseIdx || 0) % coursePages.length;
      const p = coursePages[idx];
      out.course = { title: p.title, social: `${p.title}\n\n${p.intro.split(/(?<=[.!?])\s/).slice(0, 2).join(' ')}\n\n${SITE}/courses/${p.slug}` };
      store.saveSettings({ campaignCourseIdx: idx + 1 });
    }
    store.saveSettings({ campaignRuns: runs });
    if (!out.blog && !out.poem && !out.course) { log('[campaign] nothing left in the queue.'); return out; }
    await emailPer(out);
    log(`[campaign] ${trigger}: drafted ${out.blog ? '1 blog' : 'no blog'}${out.poem ? ' and 1 poem' : ''}, emailed for approval.`);
    return out;
  }

  async function emailPer(out) {
    const btn = (href, label, bg) => `<a href="${href}" style="display:inline-block;padding:12px 22px;margin:6px 8px 6px 0;border-radius:10px;background:${bg};color:#fff;text-decoration:none;font-family:Arial,sans-serif">${label}</a>`;
    const box = t => `<div style="padding:14px 16px;border-radius:10px;background:#f3f6f4;white-space:pre-wrap;font-family:Georgia,serif;font-size:16px;line-height:1.6">${esc(t)}</div>`;
    let html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;max-width:640px">`;
    if (out.blog) {
      const f = db.getLibraryFile(out.blog.row.file_id);
      const base = `${SITE}/campaign/${out.blog.id}?t=${out.blog.token}`;
      html += `<h2 style="font-family:Georgia,serif;font-weight:normal">This week's blog: ${esc(cleanTitle(f.title))}</h2>
<p><a href="${SITE}/blog/${out.blog.row.slug}">${SITE}/blog/${out.blog.row.slug}</a></p>
<p><b>Opening now</b></p>${box(out.blog.d.old_opening)}
<p><b>Suggested fresh opening</b></p>${box(out.blog.d.new_opening)}
<p>${btn(base + '&do=approve', 'Approve the new opening', '#2f6b4f')}${btn(base + '&do=skip', 'Keep it as it is', '#777')}</p>
<p><b>Suggested social post</b></p>${box(out.blog.d.social)}`;
    }
    if (out.poem) {
      const f = db.getLibraryFile(out.poem.row.file_id);
      html += `<h2 style="font-family:Georgia,serif;font-weight:normal;margin-top:34px">This week's poem: ${esc(cleanTitle(f.title))}</h2>
<p>The poem itself stays as it is. Suggested social post:</p>${box(out.poem.social)}`;
    }
    if (out.course) {
      html += `<h2 style="font-family:Georgia,serif;font-weight:normal;margin-top:34px">This fortnight's course: ${esc(out.course.title)}</h2>
<p>Suggested social post:</p>${box(out.course.social)}`;
    }
    html += `<p style="color:#777;font-size:13px;margin-top:30px">Sent every Monday by the Deeper Mindfulness app. Nothing on the website changes until you press Approve.</p></div>`;
    await sendEmail(adminEmail, `This week's post${out.blog ? ': ' + cleanTitle(db.getLibraryFile(out.blog.row.file_id).title) : ''}`, html, { kind: 'other' });
  }

  async function approve(item) {
    const f = db.getLibraryFile(item.file_id);
    const original = await readFile(f);
    const root = parse(original);
    const article = root.querySelector('article') || root;
    const first = firstParagraph(article);
    if (!first) throw new Error('The opening paragraph could not be found any more.');
    const backupKey = 'library-backup/campaign/' + new Date().toISOString().slice(0, 10) + '-' + f.filename.replace(/^.*\//, '');
    await media.putObject(backupKey, Buffer.from(original, 'utf8'), 'text/html');
    first.set_content(esc(item.new_opening));
    const buf = Buffer.from(root.toString(), 'utf8');
    await media.putObject(f.filename, buf, 'text/html');
    db.replaceLibraryFileContent(f.id, f.filename, 'text/html', buf.length, f.original_name, 'r2', f.original_pdf_filename || null);
    publicPages.markFreshened(f.id);
    await publicPages.setPublished(f.id, true);
  }

  // The links in the email. The token in the link is what allows it, so it
  // works from a phone without logging in; each link works once.
  app.get('/campaign/:id', async (req, res) => {
    ensure();
    const page = (title, body) => res.type('html').send(`<!DOCTYPE html><html lang="en-GB"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><meta name="robots" content="noindex"></head><body style="font-family:Georgia,serif;background:#0a0f0d;color:rgba(255,255,255,0.9);max-width:640px;margin:0 auto;padding:40px 20px;line-height:1.6"><h1 style="font-weight:normal">${esc(title)}</h1>${body}</body></html>`);
    try {
      const item = db.rawAll(`SELECT * FROM campaign_items WHERE id=?`, [req.params.id])[0];
      if (!item || req.query.t !== item.token) return page('Link not valid', '<p>This link is not valid.</p>');
      if (item.status !== 'drafted') return page('Already done', `<p>This one was already ${item.status === 'approved' ? 'approved' : 'skipped'}.</p>`);
      const r = publicPages.list().find(x => x.file_id === item.file_id);
      if (req.query.do === 'skip') {
        db.rawRun(`UPDATE campaign_items SET status='skipped', decided_at=datetime('now') WHERE id=?`, [item.id]);
        return page('Kept as it is', `<p>The page stays as it was. The social post is still in the email if you want to use it.</p>${r ? `<p><a style="color:#b4e6c8" href="${r.url}">Open the page</a></p>` : ''}`);
      }
      if (req.query.do !== 'approve') return page('Nothing done', '<p>Nothing was changed.</p>');
      await approve(item);
      db.rawRun(`UPDATE campaign_items SET status='approved', decided_at=datetime('now') WHERE id=?`, [item.id]);
      page('Done', `<p>The new opening is on the page now, and it shows as updated today.</p>${r ? `<p><a style="color:#b4e6c8" href="${r.url}">Open the page</a></p>` : ''}<p>Social post to use:</p><div style="white-space:pre-wrap;padding:14px;border-radius:10px;background:rgba(255,255,255,0.06)">${esc(item.social || '')}</div>`);
    } catch (e) {
      log('[campaign] approve failed: ' + e.message);
      page('Something went wrong', `<p>${esc(e.message)}</p><p>Nothing on the page was changed.</p>`);
    }
  });

  // Mondays, between 7 and 8 in the morning UK time, once a week.
  function weekKey(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
    const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return t.getUTCFullYear() + '-W' + Math.ceil(((t - y) / 86400000 + 1) / 7);
  }
  async function tick() {
    try {
      const uk = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
      if (uk.getDay() !== 1 || uk.getHours() !== 7) return;
      const key = weekKey(uk);
      if ((store.getSettings().campaignWeek || '') === key) return;
      store.saveSettings({ campaignWeek: key });
      await draftWeek('weekly');
    } catch (e) { log('[campaign] weekly draft failed: ' + e.message); }
  }
  function start() {
    if (process.env.APP_ENV === 'staging') { log('[campaign] staging: weekly drafts not started.'); return; }
    setInterval(tick, 10 * 60 * 1000);
  }

  return { draftWeek, start, ensure };
}

module.exports = { mountCampaign, VOICE };
