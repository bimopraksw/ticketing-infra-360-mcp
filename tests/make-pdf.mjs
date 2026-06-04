/** Generates a minimal, valid one-page PDF with the PayWay request text. */
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = join(__dirname, "..", "discovery", "payway-gameshop-env.pdf");

const lines = [
  "PayWay environment variables for .env on gameshop.mobi",
  "",
  "PAYWAY_URL = https://checkout.payway.com.kh/",
  "PAYWAY_MERCHANT_ID = linkit360solution",
  "PAYWAY_SECRET_KEY = c8354fed-a9a7-4ac5-beaa-3f8e29dc75d6",
  "PAYWAY_MERCHANT_CODE = MID2023000001",
  "",
  "After adding: php artisan config:clear",
];

// Build a content stream (text). Escape PDF special chars.
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
let text = "BT /F1 11 Tf 50 760 Td 14 TL\n";
for (const l of lines) text += `(${esc(l)}) Tj T*\n`;
text += "ET";
const stream = text;

const objects = [];
objects.push("<< /Type /Catalog /Pages 2 0 R >>");
objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
objects.push(
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
);
objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

let pdf = "%PDF-1.4\n";
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefStart = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

await writeFile(out, pdf, "latin1");
console.log("Wrote", out, `(${pdf.length} bytes)`);
