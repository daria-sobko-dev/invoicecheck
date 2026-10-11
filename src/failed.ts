import { closeQueue, invoiceQueue, InvoiceJobSchema, shortId } from "./queue.js";

// Shows failed jobs. With the --retry flag, sends them again.
// Run: npm run failed   or   npm run failed -- --retry

const retry = process.argv.includes("--retry");

try {
  const jobs = await invoiceQueue.getFailed();
  if (jobs.length === 0) {
    console.log("no failed jobs");
  }

  for (const job of jobs) {
    const data = InvoiceJobSchema.safeParse(job.data);
    const fileName = data.success ? data.data.fileName : "(unknown file)";
    console.log(`[${shortId(job.id)}] ${fileName}`);
    console.log(`  attempts: ${job.attemptsMade}, reason: ${job.failedReason}`);

    if (retry) {
      // Reset the attempt counter so the job gets 3 attempts again.
      await job.retry("failed", { resetAttemptsMade: true, resetAttemptsStarted: true });
      console.log("  → sent again");
    }
  }
} finally {
  await closeQueue();
}
