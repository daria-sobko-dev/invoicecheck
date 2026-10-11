import { rm } from "node:fs/promises";
import { prisma } from "./db.js";
import { closeQueue, invoiceQueue } from "./queue.js";

// Clears the database, queue and cache so that all documents are processed again.

try {
  // Order matters: first the records that reference a document, then the documents themselves.
  // Otherwise the database will not let us delete a document that something still references.
  const [runs, violations, documents] = await prisma.$transaction([
    prisma.agentRun.deleteMany(),
    prisma.violation.deleteMany(),
    prisma.document.deleteMany(),
  ]);
  console.log(
    `deleted: Document ${documents.count}, Violation ${violations.count}, AgentRun ${runs.count}`,
  );
} finally {
  await prisma.$disconnect();
}

// obliterate deletes the whole queue: waiting, completed and failed jobs.
// force: true means "delete even if the worker is running some job right now".
try {
  await invoiceQueue.obliterate({ force: true });
  console.log("queue invoices cleared");
} finally {
  await closeQueue();
}

// force: true means "do not complain if the folder is already gone".
await rm("cache", { recursive: true, force: true });
console.log("cache folder cleared");
