import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import type { AgentRunToSave } from "./agents/llm.js";
import type { Problem } from "./rules.js";
import type { Invoice } from "./schema.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL not found in .env");
}

// The adapter is a "translator" between Prisma and the PostgreSQL driver (the pg library).
export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// File fingerprint: the same content always gives the same string,
// even if the file was renamed. If even one byte changes, the fingerprint changes too.
export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function fileHash(filePath: string): Promise<string> {
  return hashBytes(await readFile(filePath));
}

export type DocumentToSave = {
  fileName: string;
  fileHash: string;
  status: string;
  extracted: Invoice | null;
  problems: Problem[];
  explanation: string | null;
  runs: AgentRunToSave[];
};

export async function saveDocument(doc: DocumentToSave): Promise<void> {
  // Transaction: the document, its problems and agent records are written together.
  // If even one write fails, nothing is saved, not even the document itself.
  await prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        fileName: doc.fileName,
        fileHash: doc.fileHash,
        status: doc.status,
        // undefined means "do not fill this field", and the database will have NULL.
        extracted: doc.extracted ?? undefined,
        explanation: doc.explanation,
      },
    });
    await tx.violation.createMany({
      data: doc.problems.map((p) => ({ documentId: document.id, rule: p.rule, message: p.message })),
    });
    await tx.agentRun.createMany({
      data: doc.runs.map((run) => ({ ...run, documentId: document.id })),
    });
  });
}
