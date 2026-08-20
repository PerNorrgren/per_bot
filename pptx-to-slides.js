// ── pptx-to-slides.js ──
// Per's request — presentations were falling into the generic "other
// document types" bucket, which just offers a raw download link since
// browsers can't render .pptx inline (confirmed directly: on desktop
// this downloads the file instead of opening it; on mobile the attempt
// to preview it renders blank). Converting to EPUB (the PDF path) is
// the wrong tool for a slide deck — EPUB is built for reflowing text,
// and a presentation's actual content IS its visual layout: this
// converts each slide to an image instead, preserving exactly what the
// deck looks like, and the reader shows them as a swipeable, paginated
// sequence with the same reader-box/reader-controls chrome the EPUB
// reader already uses (see openPlayerFile in public/client/index.html).
//
// Pipeline: soffice --headless --convert-to pdf (LibreOffice — real
// layout fidelity, not a guess at rendering pptx XML by hand), then
// pdftoppm (poppler-utils, already in the Dockerfile for the PDF-to-
// EPUB feature) rasterizes each resulting page to a JPEG. Both tools
// already proven in this app's own toolchain, nothing new to trust.
//
// Deliberately conservative about failure, same philosophy as
// convertPdfToEpub: anything that goes wrong (corrupt file, LibreOffice
// timeout, zero pages produced) returns null rather than throwing, so
// the caller falls back to serving the original file exactly as it
// worked before this feature existed — a failed conversion must never
// be a failed upload.

const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const execFileAsync = promisify(execFile);

// A real, complex deck (many slides, embedded images/fonts) takes
// longer than the simple test file this was prototyped against —
// generous but bounded, so a genuinely stuck LibreOffice process can't
// hang an upload request forever.
const CONVERT_TIMEOUT_MS = 120000;

// pptxBuffer -> array of { slideNumber, buffer } JPEG images, in order,
// or null if conversion isn't viable for this particular file (caller
// falls back to serving the pptx itself, same as a scanned PDF falls
// back to serving the PDF itself).
async function convertPptxToSlides(pptxBuffer) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `pptx-convert-${randomUUID()}-`));
  const tmpPptxPath = path.join(tmpDir, 'source.pptx');
  try {
    fs.writeFileSync(tmpPptxPath, pptxBuffer);

    // --outdir keeps LibreOffice's output (and its lock/profile files)
    // fully inside this request's own temp dir — concurrent conversions
    // from different uploads must never share a working directory.
    await execFileAsync(
      'soffice',
      ['--headless', '--convert-to', 'pdf', '--outdir', tmpDir, tmpPptxPath],
      { timeout: CONVERT_TIMEOUT_MS }
    );

    const tmpPdfPath = path.join(tmpDir, 'source.pdf');
    if (!fs.existsSync(tmpPdfPath)) return null; // conversion silently produced nothing — treat as failure, not a crash

    const outPrefix = path.join(tmpDir, 'slide');
    // -r 150: readable on a phone screen without the per-slide file
    // ballooning — matches the resolution used elsewhere in this app's
    // own docx-verification workflow (soffice + pdftoppm -r 100-150).
    await execFileAsync('pdftoppm', ['-jpeg', '-r', '150', tmpPdfPath, outPrefix], { timeout: CONVERT_TIMEOUT_MS });

    const files = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('slide') && f.endsWith('.jpg'))
      // pdftoppm zero-pads to the width of the page count (slide-1.jpg vs
      // slide-01.jpg) depending on total pages — sort numerically by the
      // digits themselves, not lexicographically, so slide-2 never sorts
      // after slide-10.
      .sort((a, b) => {
        const numA = parseInt(a.match(/(\d+)\.jpg$/)[1], 10);
        const numB = parseInt(b.match(/(\d+)\.jpg$/)[1], 10);
        return numA - numB;
      });

    if (!files.length) return null;

    return files.map((f, i) => ({
      slideNumber: i + 1,
      buffer: fs.readFileSync(path.join(tmpDir, f)),
    }));
  } catch (e) {
    console.error('[pptx-to-slides] conversion failed:', e.message);
    return null;
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

module.exports = { convertPptxToSlides };
