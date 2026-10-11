// First: turns on Langfuse tracing before any steps.
import { shutdownTracing } from "./observability.js";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileHash, prisma, saveDocument } from "./db.js";
import { analyzeFile } from "./document.js";
import type { ProcessResult } from "./pipeline.js";

const PDF_DIR = "samples/pdf";

function printResult(result: ProcessResult): void {
  console.log(`  status: ${result.status}`);
  for (const problem of result.problems) {
    console.log(`  - ${problem.message}`);
  }
  if (result.explanation !== null) {
    console.log(`  explanation: ${result.explanation}`);
  }
}

const files = (await readdir(PDF_DIR))
  .filter((name) => name.toLowerCase().endsWith(".pdf"))
  .sort()
  .map((name) => path.join(PDF_DIR, name));

try {
  for (const file of files) {
    console.log(`\n${file}`);

    // Step 0: is this file already in the database? Then do not waste time and AI requests.
    const hash = await fileHash(file);
    const existing = await prisma.document.findUnique({ where: { fileHash: hash } });
    if (existing !== null) {
      console.log(`  already processed (document #${existing.id}, status: ${existing.status})`);
      continue;
    }

    // Step 1: PDF -> text -> agents -> rules (one trace in Langfuse).
    const { result } = await analyzeFile(file, path.basename(file), { source: "index" });

    // Step 2: print and save to the database.
    printResult(result);
    await saveDocument({ fileName: path.basename(file), fileHash: hash, ...result });
  }
} finally {
  // Close the database connection, otherwise the program will not exit by itself.
  await prisma.$disconnect();
  // Send to Langfuse the traces that are still in memory.
  await shutdownTracing();
}

// If Langfuse is unavailable, its library keeps retrying for about a minute
// and does not let the program exit. Everything is already saved, so we exit explicitly.
process.exit(0);
