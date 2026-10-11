// First: turns on Langfuse tracing before any steps.
import { shutdownTracing } from "./observability.js";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import { fileHash, prisma, saveDocument } from "./db.js";
import { analyzeFile } from "./document.js";
import { closeQueue, InvoiceJobSchema, QUEUE_NAME, redis, shortId, type InvoiceJob, type JobResult } from "./queue.js";

// Worker: takes jobs from the queue one at a time and processes them.

function time(): string {
  return new Date().toLocaleTimeString("ru-RU");
}

// Returns the job result (see JobResultSchema), also printed in the "completed: ..." line.
// Throwing Error means "temporary error, try again later".
// Throwing UnrecoverableError means "a retry will not help, go straight to failed".
async function processJob(job: Job<InvoiceJob, JobResult>): Promise<JobResult> {
  const parsed = InvoiceJobSchema.safeParse(job.data);
  if (!parsed.success) {
    throw new UnrecoverableError(`bad job data: ${parsed.error.issues[0]?.message}`);
  }
  const { filePath, fileName } = parsed.data;
  const attempts = job.opts.attempts ?? 1;
  console.log(`\n${time()} [${shortId(job.id)}] ${fileName} → attempt ${job.attemptsMade + 1}/${attempts}`);

  // Step 0: is this file already in the database? Then do not waste AI requests.
  const hash = await fileHash(filePath);
  const existing = await prisma.document.findUnique({ where: { fileHash: hash } });
  if (existing !== null) {
    return { outcome: "already_processed", documentId: existing.id };
  }

  // Step 1: PDF -> text -> agents -> rules (one trace in Langfuse).
  // No text and "not an invoice" are not failures but normal results: they are simply saved.
  const { result } = await analyzeFile(filePath, fileName, {
    source: "worker",
    metadata: { jobId: shortId(job.id), jobAttempt: `${job.attemptsMade + 1}/${attempts}` },
  });
  if (result.agentFailure !== undefined) {
    const { problem, temporary } = result.agentFailure;
    if (temporary) throw new Error(problem.message);
    throw new UnrecoverableError(problem.message);
  }

  // Step 2: save to the database, unless the same invoice is already there under another file.
  const saved = await saveDocument({ fileName, fileHash: hash, ...result });
  if (!saved.saved) return { outcome: "duplicate", duplicateOf: saved.duplicateOf };
  return { outcome: "saved", documentId: saved.documentId, status: result.status };
}

function describeResult(result: JobResult): string {
  switch (result.outcome) {
    case "saved":
      return `${result.status} (document #${result.documentId})`;
    case "already_processed":
      return `already processed (document #${result.documentId})`;
    case "duplicate":
      return `duplicate of document #${result.duplicateOf.id} (${result.duplicateOf.fileName}), not saved`;
  }
}

const worker = new Worker<InvoiceJob, JobResult>(QUEUE_NAME, processJob, {
  connection: redis,
  concurrency: 1, // one job at a time
  limiter: { max: 4, duration: 60_000 }, // no more than 4 jobs per minute
});

worker.on("completed", (job, result) => {
  console.log(`  [${shortId(job.id)}] completed: ${describeResult(result)}`);
});

worker.on("failed", (job, err) => {
  if (job === undefined) {
    console.log(`  failed: ${err.message}`);
    return;
  }
  const attempts = job.opts.attempts ?? 1;
  const willRetry = !(err instanceof UnrecoverableError) && job.attemptsMade < attempts;
  const next = willRetry ? "will retry" : "no more retries";
  console.log(`  [${shortId(job.id)}] failed: ${err.message} (${next})`);
});

// Errors of the worker itself (for example, Redis is gone), not of jobs.
worker.on("error", (err) => {
  console.error(`worker error: ${err.message}`);
});

// Ctrl+C: wait for the current job and close everything cleanly.
// Unfinished jobs stay in Redis and will run on the next start.
async function shutdown(): Promise<void> {
  console.log(`\n${time()} shutting down: waiting for the current job...`);
  await worker.close();
  await closeQueue();
  await prisma.$disconnect();
  // Send to Langfuse the traces that are still in memory.
  await shutdownTracing();
  console.log("worker stopped");
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

console.log(`${time()} worker started, waiting for jobs from queue "${QUEUE_NAME}". Ctrl+C to exit.`);
