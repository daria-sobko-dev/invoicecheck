import { readFile } from "node:fs/promises";
import { PDFParse } from "pdf-parse";

// If there are fewer letters, we assume there is no text layer (it is a scan or an image).
const MIN_TEXT_LENGTH = 20;

export const NO_TEXT_LAYER = "no text layer, OCR required";

export type PdfTextResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export async function readPdfText(filePath: string): Promise<PdfTextResult> {
  let parser: PDFParse | null = null;
  try {
    parser = new PDFParse({ data: await readFile(filePath) });
    const result = await parser.getText();

    // Take the page texts, not result.text: it contains service markers
    // like "-- 1 of 1 --", which would make a scan look like text.
    const text = result.pages.map((page) => page.text).join("\n").trim();

    if (text.length < MIN_TEXT_LENGTH) {
      return { ok: false, error: NO_TEXT_LAYER };
    }
    return { ok: true, text };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `cannot read PDF: ${reason}` };
  } finally {
    // Free the memory the library used for the document.
    await parser?.destroy();
  }
}
