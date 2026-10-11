import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";

const OUT_DIR = "samples/pdf";
const TXT_FILES = [
  "samples/invoice-ok.txt",
  "samples/invoice-bad-total.txt",
  "samples/invoice-no-date.txt",
  "samples/statement.txt",
  "samples/invoice-date-words.txt",
  "samples/invoice-eu-format.txt",
  "samples/invoice-total-due.txt",
];

// Creates a PDF: draw renders the content, and we wait until the file is fully written to disk.
function writePdf(outFile: string, draw: (doc: PDFKit.PDFDocument) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const stream = createWriteStream(outFile);
    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.pipe(stream);
    draw(doc);
    doc.end();
  });
}

await mkdir(OUT_DIR, { recursive: true });

for (const txtFile of TXT_FILES) {
  const text = await readFile(txtFile, "utf-8");
  const outFile = path.join(OUT_DIR, `${path.basename(txtFile, ".txt")}.pdf`);
  // Courier: all letters have the same width, so the columns stay aligned.
  await writePdf(outFile, (doc) => doc.font("Courier").fontSize(11).text(text));
  console.log(`created ${outFile}`);
}

// "Scan": just a gray rectangle, no text inside.
const scanFile = path.join(OUT_DIR, "scan.pdf");
await writePdf(scanFile, (doc) => {
  doc.rect(50, 50, 495, 700).fillAndStroke("#dddddd", "#555555");
});
console.log(`created ${scanFile}`);
