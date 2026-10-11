import { z } from "zod";
import { prisma } from "../db.js";
import { invoiceQueue, redis } from "../queue.js";
import { withTimeout } from "../timeout.js";
import { documentsRouter } from "./documents.js";
import { protectedProcedure, publicProcedure, router } from "./trpc.js";

// Main router: all API procedures in one place.
// The client takes its TYPE (AppRouter), so types do not need to be duplicated by hand.

const CHECK_TIMEOUT_MS = 2000; // health will not wait longer than this for the database or Redis

async function isAlive(check: () => Promise<unknown>): Promise<boolean> {
  try {
    await withTimeout(check(), CHECK_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

// health: is the API alive? Can it reach Postgres and Redis? No key needed.
const health = publicProcedure
  .output(z.object({ ok: z.boolean(), postgres: z.boolean(), redis: z.boolean() }))
  .query(async () => {
    const [postgres, redisOk] = await Promise.all([
      isAlive(() => prisma.$queryRaw`SELECT 1`),
      isAlive(() => redis.ping()),
    ]);
    return { ok: postgres && redisOk, postgres, redis: redisOk };
  });

// queue.stats: how many jobs are in each state.
const QueueStats = z.object({
  waiting: z.number().int(),
  active: z.number().int(),
  delayed: z.number().int(),
  completed: z.number().int(),
  failed: z.number().int(),
});

const stats = protectedProcedure.output(QueueStats).query(async () => {
  const counts = await invoiceQueue.getJobCounts("waiting", "active", "delayed", "completed", "failed");
  return QueueStats.parse(counts);
});

export const appRouter = router({
  health,
  documents: documentsRouter,
  queue: router({ stats }),
});

export type AppRouter = typeof appRouter;
