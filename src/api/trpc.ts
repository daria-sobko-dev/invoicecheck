import "dotenv/config";
import { createHash, timingSafeEqual } from "node:crypto";
import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateHTTPContextOptions } from "@trpc/server/adapters/standalone";

// API foundation: the request context and two kinds of procedures (public and key-protected).

// Context: what every procedure knows about the request. We only need the key from the header.
export type Context = { apiKey: string | null };

export function createContext({ req }: CreateHTTPContextOptions): Context {
  const header = req.headers["x-api-key"];
  return { apiKey: typeof header === "string" ? header : null };
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;

// Public procedure: no key needed (only health).
export const publicProcedure = t.procedure;

// Compare keys in constant time so that the response speed
// cannot be used to guess the key one character at a time.
function sameKey(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// Protected procedure: without the correct x-api-key we answer UNAUTHORIZED.
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  const expected = process.env.API_KEY;
  if (!expected) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "API_KEY is not configured on the server" });
  }
  if (ctx.apiKey === null || !sameKey(ctx.apiKey, expected)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "missing or wrong x-api-key header" });
  }
  return next();
});
