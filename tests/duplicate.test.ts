import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileHash, hashBytes, prisma, saveDocument, type DocumentToSave } from "../src/db.js";
import { readPdfText } from "../src/pdf.js";
import type { Invoice } from "../src/schema.js";

// Duplicate detection by business key (invoiceNumber + vendor), without Gemini.
// Postgres must be running (docker compose up -d).

const FILE_PREFIX = "dup-test-"; // every document of this test has this name, so we can clean up

const INVOICE_TEXT = `INVOICE TEST-DUP-0001
Vendor: Duplicate Test Vendor Ltd
Date: 2026-09-01

Consulting                         100.00
TOTAL (EUR)                        100.00`;

// What the Extractor returns for this text. Tests never call Gemini, but in real runs
// the same text gives the same answer: the model cache is keyed by the prompt, which contains the text.
const EXTRACTED: Invoice = {
  invoiceNumber: "TEST-DUP-0001",
  date: "2026-09-01",
  vendor: "Duplicate Test Vendor Ltd",
  currency: "EUR",
  total: 100,
  lineItems: [{ description: "Consulting", amount: 100 }],
};

let dir = "";

// The same invoice rendered by pdfkit, like npm run make-pdfs does.
// pdfkit writes the creation date into the file, so a later run gives other bytes.
function makePdf(createdAt: Date): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, info: { CreationDate: createdAt } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.font("Courier").fontSize(11).text(INVOICE_TEXT);
    doc.end();
  });
}

function toSave(fileName: string, hash: string, extracted: Invoice): DocumentToSave {
  return { fileName, fileHash: hash, status: "ok", extracted, problems: [], explanation: null, runs: [] };
}

async function deleteTestDocuments(): Promise<void> {
  const where = { fileName: { startsWith: FILE_PREFIX } };
  const docs = await prisma.document.findMany({ where, select: { id: true } });
  const ids = docs.map((d) => d.id);
  await prisma.violation.deleteMany({ where: { documentId: { in: ids } } });
  await prisma.agentRun.deleteMany({ where: { documentId: { in: ids } } });
  await prisma.document.deleteMany({ where });
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "invoicecheck-dup-"));
  await deleteTestDocuments();
});

afterAll(async () => {
  await deleteTestDocuments();
  await rm(dir, { recursive: true, force: true });
  await prisma.$disconnect();
});

describe("duplicates by invoiceNumber + vendor", () => {
  it("the same PDF generated twice (different bytes) is a duplicate the second time", async () => {
    const first = path.join(dir, "first.pdf");
    const second = path.join(dir, "second.pdf");
    await writeFile(first, await makePdf(new Date("2026-10-01T10:00:00Z")));
    await writeFile(second, await makePdf(new Date("2026-10-02T10:00:00Z")));

    // Different bytes, so the file hash check alone would treat them as two documents...
    const firstHash = await fileHash(first);
    const secondHash = await fileHash(second);
    expect(firstHash).not.toBe(secondHash);

    // ...but the text inside is the same invoice.
    const firstText = await readPdfText(first);
    const secondText = await readPdfText(second);
    expect(firstText.ok && secondText.ok).toBe(true);
    if (!firstText.ok || !secondText.ok) return;
    expect(secondText.text).toBe(firstText.text);
    expect(firstText.text).toContain("TEST-DUP-0001");

    const saved = await saveDocument(toSave(`${FILE_PREFIX}first.pdf`, firstHash, EXTRACTED));
    expect(saved.saved).toBe(true);

    const again = await saveDocument(toSave(`${FILE_PREFIX}second.pdf`, secondHash, EXTRACTED));
    expect(again).toEqual({
      saved: false,
      duplicateOf: {
        id: saved.saved ? saved.documentId : -1,
        fileHash: firstHash,
        fileName: `${FILE_PREFIX}first.pdf`,
      },
    });

    // The second file is not in the database: one invoice, one document.
    expect(await prisma.document.count({ where: { invoiceNumber: "TEST-DUP-0001" } })).toBe(1);
    expect(await prisma.document.findUnique({ where: { fileHash: secondHash } })).toBeNull();
  });

  it("invoices without a number are never merged", async () => {
    const noNumber: Invoice = { ...EXTRACTED, invoiceNumber: null };
    const a = await saveDocument(toSave(`${FILE_PREFIX}no-number-a.pdf`, hashBytes(Buffer.from("no-number-a")), noNumber));
    const b = await saveDocument(toSave(`${FILE_PREFIX}no-number-b.pdf`, hashBytes(Buffer.from("no-number-b")), noNumber));
    expect(a.saved).toBe(true);
    expect(b.saved).toBe(true);
  });
});
