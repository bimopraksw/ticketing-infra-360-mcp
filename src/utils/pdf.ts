/**
 * Minimal dependency-free PDF generator.
 *
 * Produces a valid one-page (multi-page if long) PDF from plain text, used to
 * auto-create an attachment when the user provides a ticket description but no
 * file (several LinkIT360 forms require at least one upload). The text should
 * already be polished/neat by the caller — this only lays it out.
 */

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 50;
const FONT_SIZE = 11;
const LEADING = 15;
const MAX_CHARS_PER_LINE = 92; // approx for Helvetica 11pt within margins
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - 2 * MARGIN) / LEADING);

function escapePdfText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/\r/g, "");
}

/** Wraps long lines to a reasonable width. */
function wrapLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\t/g, "    ").split("\n")) {
    if (raw.length <= MAX_CHARS_PER_LINE) {
      out.push(raw);
      continue;
    }
    let line = raw;
    while (line.length > MAX_CHARS_PER_LINE) {
      let cut = line.lastIndexOf(" ", MAX_CHARS_PER_LINE);
      if (cut <= 0) cut = MAX_CHARS_PER_LINE;
      out.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
    }
    out.push(line);
  }
  return out;
}

/** Builds a PDF buffer from text. `title` is rendered bold-ish at the top. */
export function makeTextPdf(text: string, title?: string): Buffer {
  const allLines = wrapLines((title ? `${title}\n\n` : "") + text);

  // Split into pages.
  const pages: string[][] = [];
  for (let i = 0; i < allLines.length; i += LINES_PER_PAGE) {
    pages.push(allLines.slice(i, i + LINES_PER_PAGE));
  }
  if (pages.length === 0) pages.push([""]);

  const objects: string[] = [];
  // 1: Catalog, 2: Pages, 5: Font are fixed; page + content objects follow.
  const fontObjNum = 3;
  const pageObjNums: number[] = [];
  const contentObjNums: number[] = [];

  // Reserve object numbers: 1 catalog, 2 pages, 3 font, then per page: page + content.
  let next = 4;
  for (let i = 0; i < pages.length; i++) {
    pageObjNums.push(next++);
    contentObjNums.push(next++);
  }

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[fontObjNum] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  pages.forEach((lines, idx) => {
    const startY = PAGE_HEIGHT - MARGIN;
    let stream = `BT /F1 ${FONT_SIZE} Tf ${MARGIN} ${startY} Td ${LEADING} TL\n`;
    for (const l of lines) stream += `(${escapePdfText(l)}) Tj T*\n`;
    stream += "ET";
    objects[contentObjNums[idx]] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    objects[pageObjNums[idx]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Contents ${contentObjNums[idx]} 0 R /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> >>`;
  });

  const total = next - 1;
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n <= total; n++) {
    offsets[n] = Buffer.byteLength(pdf, "latin1");
    pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= total; n++) {
    pdf += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(pdf, "latin1");
}
