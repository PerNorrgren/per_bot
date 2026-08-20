// ── pdf-to-epub.js ──
// Per's request — reads lesson PDFs through the same reader that already
// works well for real EPUBs, instead of the broken image-in-an-iframe
// mobile experience. Extracts structure via pdftohtml (poppler-utils —
// see Dockerfile) rather than plain text extraction: font size, bold,
// italic, and — when the source PDF was exported from a properly-headed
// Word document, as these lesson documents are — the real PDF bookmarks
// as an actual outline, used to confirm heading detection rather than
// guessing from font size alone.
//
// Deliberately conservative about failure: anything that goes wrong here
// (a scanned/image-only PDF with no text layer, a malformed file,
// pdftohtml or the epub builder throwing) returns null rather than
// throwing, so the caller can fall back to serving the original PDF
// exactly as it worked before this feature existed — a failed conversion
// must never be a failed upload.

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const execFileAsync = promisify(execFile);

function mostCommon(arr) {
  const counts = {};
  arr.forEach(v => counts[v] = (counts[v] || 0) + 1);
  return Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
}

// Parses pdftohtml's -xml output into clean, structured HTML — headings
// detected by font size (cross-checked against the PDF's own real
// bookmarks when present), consecutive same-size nearby lines merged
// back into real paragraphs, bold/italic preserved.
function structuredHtmlFromPdftohtmlXml(xml) {
  const outlineMatches = [...xml.matchAll(/<item page="\d+">([^<]*)<\/item>/g)];
  const outlineTexts = new Set(outlineMatches.map(m => m[1].trim()));

  const fontSizes = {};
  for (const m of xml.matchAll(/<fontspec id="(\d+)" size="(\d+)"/g)) {
    fontSizes[m[1]] = parseInt(m[2], 10);
  }
  const sizeValues = Object.values(fontSizes);
  if (!sizeValues.length) return null; // no text layer at all — likely scanned/image-only
  const bodySize = mostCommon(sizeValues);

  const blocks = [];
  for (const m of xml.matchAll(/<text top="(\d+)"[^>]*font="(\d+)"[^>]*>([\s\S]*?)<\/text>/g)) {
    const top = parseInt(m[1], 10);
    const size = fontSizes[m[2]] || bodySize;
    let content = m[3]
      .replace(/<b>/g, '<strong>').replace(/<\/b>/g, '</strong>')
      .replace(/<i>/g, '<em>').replace(/<\/i>/g, '</em>')
      .trim();
    if (!content) continue;
    const plainText = content.replace(/<[^>]+>/g, '').trim();
    if (!plainText) continue;
    blocks.push({ top, size, content, plainText });
  }
  if (!blocks.length) return null;

  // Merge consecutive same-size nearby lines into real paragraphs.
  // prev.top is deliberately updated on every merge (a real bug caught
  // during prototyping: without this, the distance check for the 3rd+
  // line in a paragraph compares against the paragraph's FIRST line
  // forever instead of its most recent one, and compounds until it
  // wrongly fails the threshold).
  const merged = [];
  for (const b of blocks) {
    const prev = merged[merged.length - 1];
    const isHeadingCandidate = b.size > bodySize + 1 || outlineTexts.has(b.plainText);
    const willMerge = !isHeadingCandidate && prev && !prev.isHeading && prev.size === b.size && (b.top - prev.top) < b.size * 1.8;
    if (willMerge) {
      prev.content += ' ' + b.content;
      prev.plainText += ' ' + b.plainText;
      prev.top = b.top;
    } else {
      merged.push({ ...b, isHeading: isHeadingCandidate });
    }
  }

  const headingSizes = [...new Set(merged.filter(b => b.isHeading).map(b => b.size))].sort((a, b) => b - a);
  const html = merged.map(b => {
    if (b.isHeading) {
      const level = Math.min(headingSizes.indexOf(b.size) + 1, 3) || 2;
      return `<h${level}>${b.content}</h${level}>`;
    }
    return `<p>${b.content}</p>`;
  }).join('\n');

  return html;
}

// pdfBuffer -> epub Buffer, or null if conversion isn't viable for this
// particular file (caller falls back to serving the PDF itself).
async function convertPdfToEpub(pdfBuffer, title, author) {
  const tmpDir = os.tmpdir();
  const tmpPdfPath = path.join(tmpDir, `pdf-convert-${randomUUID()}.pdf`);
  try {
    fs.writeFileSync(tmpPdfPath, pdfBuffer);
    const { stdout: xml } = await execFileAsync('pdftohtml', ['-xml', '-stdout', tmpPdfPath], { maxBuffer: 50 * 1024 * 1024 });
    const html = structuredHtmlFromPdftohtmlXml(xml);
    if (!html || !html.trim()) return null; // no usable text layer — likely a scanned PDF

    const epub = require('epub-gen-memory').default;
    // beforeToc:true — a real bug Per hit and reported directly: without
    // this, epub-gen-memory unconditionally puts its own generated
    // table-of-contents page FIRST in the spine, ahead of the actual
    // chapter, regardless of chapter count. For a single-chapter document
    // (every one of these conversions, always exactly one chapter) that
    // meant opening on a near-empty "table of contents with one line"
    // instead of the real content, with navigating past it apparently
    // broken too. This app already has its own proper table of contents
    // (the ☰ button, built from the epub's real navigation data) — the
    // generated toc.xhtml page is pure redundancy here even positioned
    // correctly, so putting the real content first is strictly better,
    // not just a workaround. Verified directly against a real converted
    // file's own content.opf before trusting this: without beforeToc,
    // the spine read toc-then-content; with it, content-then-toc.
    const buffer = await epub(
      { title: title || 'Document', author: author || 'Deeper Mindfulness' },
      [{ title: title || 'Document', content: html, beforeToc: true }]
    );
    return buffer;
  } catch (e) {
    console.error('[pdf-to-epub] conversion failed:', e.message);
    return null;
  } finally {
    fs.unlink(tmpPdfPath, () => {});
  }
}

module.exports = { convertPdfToEpub };
