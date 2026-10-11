import "dotenv/config";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";

// One queue "invoices": a job = one PDF that needs processing.

// The name can be changed with an environment variable: tests use a separate
// queue "invoices-test", so the worker does not take their jobs and call Gemini.
export const QUEUE_NAME = process.env.QUEUE_NAME ?? "invoices";

// Job data. The worker checks it with this schema before working.
export const InvoiceJobSchema = z.object({
  filePath: z.string().min(1),
  fileName: z.string().min(1),
});
export type InvoiceJob = z.infer<typeof InvoiceJobSchema>;

// What a finished job returns. BullMQ keeps it in Redis, and the API reads it back
// to tell the client what happened, so it is checked with this schema there too.
export const JobResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("saved"), documentId: z.number().int(), status: z.string() }),
  z.object({ outcome: z.literal("already_processed"), documentId: z.number().int() }),
  // Same invoiceNumber and vendor as an existing document, but another file: not saved.
  z.object({
    outcome: z.literal("duplicate"),
    duplicateOf: z.object({ id: z.number().int(), fileHash: z.string(), fileName: z.string() }),
  }),
]);
export type JobResult = z.infer<typeof JobResultSchema>;

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL not found in .env");
}

// BullMQ needs maxRetriesPerRequest: null: the Redis client should wait to reconnect
// instead of throwing an error if Redis disappears for a second.
export const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

export const invoiceQueue = new Queue<InvoiceJob, JobResult>(QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3, // total attempts per job
    backoff: { type: "exponential", delay: 5000 }, // pauses between attempts: 5 s, then 10 s
  },
});

// Short id for output: the first 8 characters of the file fingerprint.
export function shortId(jobId: string | undefined): string {
  return (jobId ?? "????????").slice(0, 8);
}

export async function closeQueue(): Promise<void> {
  await invoiceQueue.close();
  await redis.quit();
}
