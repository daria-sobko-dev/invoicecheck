import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileHash } from "./db.js";
import { closeQueue, invoiceQueue, shortId } from "./queue.js";

// Producer: only puts jobs into the queue, does not process anything itself.

const PDF_DIR = "samples/pdf";

const files = (await readdir(PDF_DIR))
  .filter((name) => name.toLowerCase().endsWith(".pdf"))
  .sort();

try {
  for (const fileName of files) {
    const filePath = path.join(PDF_DIR, fileName);
    // jobId = file fingerprint: the same file will not get into the queue twice.
    const jobId = await fileHash(filePath);

    const existing = await invoiceQueue.getJob(jobId);
    if (existing !== undefined) {
      const state = await existing.getState();
      console.log(`  already queued [${shortId(jobId)}] ${fileName} (state: ${state})`);
      continue;
    }

    await invoiceQueue.add("invoice", { filePath, fileName }, { jobId });
    console.log(`  added          [${shortId(jobId)}] ${fileName}`);
  }
} finally {
  await closeQueue();
}
