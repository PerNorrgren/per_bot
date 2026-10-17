// article_upload.js — Per App 38 (26/27): blogs and white papers get their
// public page automatically.
//
// Per (17 Oct 2026): "when I upload a whitepaper or blog it automatically
// adds it as an external page as well please" … "I never (or rarely) upload
// word documents, only .pdf".
//
// PDF (the usual case, round 27): the app keeps showing the file exactly as
// before (the PDF, or its reader version). The public page is built from the
// PDF's text (the same converter the app's reader uses), saved separately,
// and rebuilt whenever the file is replaced. If the title is just the file
// name, the PDF's own title and subtitle are used.
//
// When a file is uploaded to the Library as a Blog or a Whitepaper:
//  - A Word file (.docx) is turned into the same simple HTML article the
//    app's reader already shows for every other blog: headings, paragraphs,
//    lists, links, pictures, boxed notes and tables. The title, subtitle and
//    byline lines at the top of the document are recognised; the byline
//    (author, edition, draft) is left out, and today's date is added as the
//    "Originally published" date.
//  - If the upload's title is just the file name (The_Restful_Awake_v1),
//    the title is taken from the document itself, with its subtitle.
//  - The piece then gets its public page straight away: blogs at
//    /blog/<name>, white papers at /papers/<name>, with the Search entry,
//    sitemap and social preview, exactly as the 🌐 button does. Pieces given
//    to one person, or marked as facilitator resources, stay private.
// The 🌐 button in the Library still takes any page off the website.

const mammoth = require('mammoth');
const { parse } = require('node-html-parser');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const WRITING = ['blog', 'whitepaper'];

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const textOf = el => (el.text || '').replace(/\s+/g, ' ').trim();
const isDocx = (contentType, name) => contentType === DOCX_MIME || /\.docx$/i.test(String(name || ''));

const NOTE_STYLE = 'margin:22px 0;padding:14px 18px;border-radius:12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-left:3px solid rgba(180,230,200,0.5)';

// Word → { html, title, subtitle }
async function docxToArticle(buffer, { date } = {}) {
  const { value } = await mammoth.convertToHtml({ buffer }, {
    // The page has its own title, so the document's headings move down one level.
    styleMap: [
      "p[style-name='Title'] => h1.doc-title:fresh",
      "p[style-name='Subtitle'] => p.subtitle:fresh",
      "p[style-name='Heading 1'] => h2:fresh",
      "p[style-name='Heading 2'] => h3:fresh",
      "p[style-name='Heading 3'] => h4:fresh",
      "p[style-name='Heading 4'] => h4:fresh",
    ],
  });
  return tidyArticle(value, { date });
}

// Rough article HTML (from Word or a PDF) → { html, title, subtitle }:
// title block recognised, byline lines dropped, headings below the page
// title, boxed notes and tables made readable, wrapped as a full article.
function tidyArticle(value, { date } = {}) {
  const root = parse(`<div id="doc">${value}</div>`);
  const doc = root.querySelector('#doc');

  // Empty paragraphs (spacing in Word).
  for (const p of doc.querySelectorAll('p')) if (!textOf(p) && !p.querySelector('img')) p.remove();

  // The title block at the top: title, subtitle, byline lines.
  let title = '', subtitle = '';
  const kids = () => doc.childNodes.filter(n => n.nodeType === 1);
  let first = kids()[0];
  if (first) {
    const t = textOf(first);
    const strong = first.querySelector('strong');
    const allBold = first.tagName === 'P' && strong && textOf(strong) === t;
    if ((first.tagName === 'H1' || allBold) && t.length < 140) { title = t; first.remove(); }
  }
  for (let i = 0; i < 5; i++) {
    const el = kids()[0];
    if (!el || !/^(P|H2|H3|H4)$/.test(el.tagName)) break;
    const t = textOf(el);
    if (t.length > 220) break;
    const cls = el.getAttribute('class') || '';
    // A PDF subtitle often arrives as a smaller heading straight under the title.
    if (el.tagName !== 'P' && !(title && !subtitle && i === 0)) break;
    if (/·|\bPer Norrgren\b|\b(draft|edition|version)\b/i.test(t) && !/subtitle/.test(cls)) { el.remove(); continue; }
    if (!subtitle && title && t.length <= 170 && (/subtitle/.test(cls) || el.tagName !== 'P' || !/[.!?]$/.test(t))) { subtitle = t; el.remove(); continue; }
    break;
  }

  // Any other top-level heading 1 becomes a section heading.
  for (const h of doc.querySelectorAll('h1')) h.tagName = 'h2';
  // Headings from a PDF arrive wrapped in bold; the page styles them already.
  for (const h of doc.querySelectorAll('h2, h3, h4')) {
    const only = h.childNodes.filter(n => n.nodeType === 1 || textOf(n));
    if (only.length === 1 && only[0].tagName === 'STRONG') h.set_content(only[0].innerHTML);
  }

  // Word tables: a single-cell table is a boxed note; real tables scroll on phones.
  for (const table of doc.querySelectorAll('table')) {
    const cells = table.querySelectorAll('td, th');
    if (cells.length === 1) {
      table.replaceWith(parse(`<aside class="note" style="${NOTE_STYLE}">${cells[0].innerHTML}</aside>`));
    } else {
      table.replaceWith(parse(`<div class="table-wrap" style="overflow-x:auto">${table.toString()}</div>`));
    }
  }
  // Links open in a new tab; Word's own bookmarks go.
  for (const a of doc.querySelectorAll('a')) {
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#_')) { a.replaceWith(a.innerHTML); continue; }
    if (/^https?:/i.test(href)) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); }
  }

  const day = date || new Date().toISOString().slice(0, 10);
  const html = `<!DOCTYPE html>
<html lang="en-GB">
<head><meta charset="utf-8"><title>${esc(title || 'Untitled')}</title></head>
<body>
<article>
${title ? `<h1>${esc(title)}</h1>\n` : ''}${subtitle ? `<p class="subtitle"><em>${esc(subtitle)}</em></p>\n` : ''}<p class="meta">Originally published ${day}</p>
${doc.innerHTML}
</article>
</body>
</html>`;
  return { html, title, subtitle };
}

// PDF → { html, title, subtitle }, or null when it has no usable text
// (a scanned PDF, say).
async function pdfToArticle(buffer, { date } = {}) {
  const { pdfToHtml } = require('./pdf-to-epub');
  const raw = await pdfToHtml(buffer);
  return raw ? tidyArticle(raw, { date }) : null;
}

// For the upload route: the PDF's own "Title: subtitle", when the upload's
// title is just the file name. Returns null to keep the title as it is.
async function titleFromPdf({ media, key = null, buffer = null, contentKind, title, originalName, log = console.log }) {
  if (!WRITING.includes(contentKind) || !(key || buffer) || !isFileNameTitle(title, originalName)) return null;
  try {
    const art = await pdfToArticle(buffer || await readKey(media, key));
    if (!art || !art.title) return null;
    return { title: art.subtitle ? `${art.title}: ${art.subtitle}` : art.title, subtitle: art.subtitle };
  } catch (e) { log('[article-upload] could not read the PDF title: ' + e.message); return null; }
}

// True when the title is just the uploaded file's name (the upload form's
// default), so the document's own title is the better one.
function isFileNameTitle(title, originalName) {
  const norm = s => String(s || '').toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/[^a-z0-9]+/g, '').replace(/v\d+$/, '');
  return !title || !originalName || norm(title) === norm(originalName);
}

async function readKey(media, key) {
  const obj = await media.getPublicObject(key);
  const chunks = []; for await (const c of obj.Body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

// For the upload and replace routes. Returns null when nothing needs doing,
// otherwise the new stored file: { key, contentType, size, title, subtitle }.
// The converted article is saved to R2; the Word file itself is removed.
async function convertIfWordArticle({ media, uuid, contentKind, contentType, originalName, title, key = null, buffer = null, log = console.log }) {
  if (!WRITING.includes(contentKind) || !isDocx(contentType, originalName) || !media.isConfigured()) return null;
  try {
    const buf = buffer || await readKey(media, key);
    const art = await docxToArticle(buf);
    const newKey = `library/${uuid()}.html`;
    const out = Buffer.from(art.html, 'utf8');
    await media.putObject(newKey, out, 'text/html');
    if (key) media.deleteObject(key).catch(() => {});
    const docTitle = art.title ? (art.subtitle ? `${art.title}: ${art.subtitle}` : art.title) : '';
    return {
      key: newKey, contentType: 'text/html', size: out.length, subtitle: art.subtitle,
      title: docTitle && isFileNameTitle(title, originalName) ? docTitle : String(title || docTitle || 'Untitled').trim(),
    };
  } catch (e) {
    log('[article-upload] Word conversion failed, keeping the file as it is: ' + e.message);
    return null;
  }
}

// Gives a newly uploaded blog or white paper its public page. Returns the
// address, or null (not public writing, private to someone, or it failed).
async function autoPublish(publicPages, fileId, { contentKind, assignedClientId, facilitatorResource, log = console.log }) {
  if (!WRITING.includes(contentKind) || assignedClientId || facilitatorResource) return null;
  try {
    const item = await publicPages.setPublished(fileId, true, { defaultDate: new Date().toISOString().slice(0, 10) });
    return item && item.url || null;
  } catch (e) { log('[article-upload] public page not made: ' + e.message); return null; }
}

module.exports = { docxToArticle, tidyArticle, pdfToArticle, titleFromPdf, readKey, convertIfWordArticle, autoPublish, isFileNameTitle, DOCX_MIME, WRITING };
