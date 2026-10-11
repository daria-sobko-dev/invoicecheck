import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError, GoogleGenAI, type GenerateContentResponseUsageMetadata } from "@google/genai";
import { startActiveObservation } from "@langfuse/tracing";
import { z } from "zod";
import type { Prisma } from "../generated/prisma/client.js";

// Shared code for all agents: Gemini call, timeout, retries, cache.

export const MODEL = "gemini-3.5-flash-lite";
const AGENT_TIMEOUT_MS = 20_000; // an agent must answer within 20 seconds, including retries
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
const PAUSE_BETWEEN_CALLS_MS = 4000; // pause between requests so we do not hit the per-minute limit
const CACHE_DIR = "cache";
const CACHE_MODEL = "cache"; // the model name we write to AgentRun if the answer came from the cache

// Confidence: a number from 0 (a guess) to 1 (certain).
export const ConfidenceSchema = z.number().min(0).max(1);

// A record for the AgentRun table.
// Prisma.InputJsonValue is "any value that can be saved as JSON".
export type AgentRunToSave = {
  agent: string;
  model: string;
  input: Prisma.InputJsonValue;
  output: Prisma.InputJsonValue;
};

// temporary: the error is temporary (overload, rate limit, timeout, network), it may work later.
// If false, a retry will not help: for example, the model's answer failed the schema.
export type AgentFailure = { ok: false; error: string; timedOut: boolean; temporary: boolean };
export type AgentResult<T> = { ok: true; data: T } | AgentFailure;

// What each agent returns: its result and a record for AgentRun.
export type AgentOutcome<T> = { result: AgentResult<T>; run: AgentRunToSave };

// What went wrong in a single attempt.
type Failure = {
  status: number | null; // HTTP code from Google, or null if the error did not come from Google
  reason: string; // short reason
  retryAfterMs: number | null; // how long Google asks us to wait (only for 429)
  temporary: boolean; // whether a retry later can help (see AgentFailure)
};

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  throw new Error("GEMINI_API_KEY not found in .env");
}
const ai = new GoogleGenAI({ apiKey });

const SHORT_REASONS: Record<number, string> = {
  400: "bad request",
  403: "access denied (check API key)",
  404: "model not found",
  429: "rate limit exceeded",
  500: "server error",
  503: "model overloaded",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// In a 429 error Google writes something like "Please retry in 41.2s"
// or, if the daily limit is used up, "Please retry in 12h12m44.2s".
function parseRetryAfterMs(message: string): number | null {
  const match = message.match(/retry in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3]);
  return Math.ceil(hours * 3600 + minutes * 60 + seconds) * 1000;
}

// Turns any error into a short description instead of a huge JSON.
function toFailure(err: unknown): Failure {
  if (err instanceof ApiError) {
    return {
      status: err.status,
      reason: SHORT_REASONS[err.status] ?? "unexpected API error",
      retryAfterMs: err.status === 429 ? parseRetryAfterMs(err.message) : null,
      temporary: err.status === 429 || err.status >= 500,
    };
  }
  if (err instanceof SyntaxError) {
    return { status: null, reason: "model returned invalid JSON", retryAfterMs: null, temporary: false };
  }
  // Everything else is usually a network glitch: the connection blinked, it may work later.
  const reason = err instanceof Error ? err.message : String(err);
  return { status: null, reason, retryAfterMs: null, temporary: true };
}

function describe(failure: Failure): string {
  return failure.status === null ? failure.reason : `${failure.status}: ${failure.reason}`;
}

// Retrying only makes sense for temporary problems: overload, rate limit,
// server failure or a malformed model answer. A retry will not help with 404 or 403.
function isRetryable(failure: Failure): boolean {
  return failure.status === null || failure.status === 429 || failure.status >= 500;
}

// Call settings. Eval changes them: --fresh does not read the cache and makes pauses longer.
let readFromCache = true;
let pauseBetweenCallsMs = PAUSE_BETWEEN_CALLS_MS;
export function configureModelCalls(options: { readFromCache: boolean; pauseBetweenCallsMs: number }): void {
  readFromCache = options.readFromCache;
  pauseBetweenCallsMs = options.pauseBetweenCallsMs;
}

// Keep a pause between real Gemini requests (cache hits can go right away).
let lastCallAt = 0;
async function waitForTurn(): Promise<void> {
  const wait = lastCallAt + pauseBetweenCallsMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

type AttemptResult<T> = { ok: true; data: T } | { ok: false; failure: Failure; timedOut: boolean };

// Tokens from the Gemini response in Langfuse format. If a field is missing, we just skip it.
function usageDetails(usage: GenerateContentResponseUsageMetadata | undefined): Record<string, number> {
  const details: Record<string, number> = {};
  if (usage?.promptTokenCount !== undefined) details.input = usage.promptTokenCount;
  if (usage?.candidatesTokenCount !== undefined) details.output = usage.candidatesTokenCount;
  if (usage?.totalTokenCount !== undefined) details.total = usage.totalTokenCount;
  return details;
}

// One attempt to call Gemini. In Langfuse this is a separate step of type generation:
// model, prompt, answer, tokens, attempt number, time and the error, if any.
async function attemptCall<T>(
  agent: string,
  prompt: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  attempt: number,
): Promise<AttemptResult<T>> {
  return startActiveObservation(
    `${agent}: gemini`,
    async (generation): Promise<AttemptResult<T>> => {
      generation.update({ model: MODEL, input: prompt, metadata: { agent, attempt } });
      let failure: Failure;
      try {
        const response = await ai.models.generateContent({
          model: MODEL,
          contents: prompt,
          config: { responseMimeType: "application/json", abortSignal: signal },
        });
        generation.update({
          output: response.text,
          usageDetails: usageDetails(response.usageMetadata),
          metadata: { modelVersion: response.modelVersion ?? MODEL },
        });

        const json: unknown = JSON.parse(response.text ?? "");

        // The model's answer is a hypothesis: we check it with the schema.
        const parsed = schema.safeParse(json);
        if (parsed.success) {
          return { ok: true, data: parsed.data };
        }
        const issue = parsed.error.issues[0];
        failure = {
          status: null,
          reason: `schema check failed at "${issue?.path.join(".")}": ${issue?.message}`,
          retryAfterMs: null,
          temporary: false,
        };
      } catch (err) {
        if (signal.aborted) {
          generation.update({ level: "ERROR", statusMessage: "Agent timeout" });
          return { ok: false, failure: { status: null, reason: "Agent timeout", retryAfterMs: null, temporary: true }, timedOut: true };
        }
        failure = toFailure(err);
      }
      generation.update({ level: "ERROR", statusMessage: describe(failure) });
      return { ok: false, failure, timedOut: false };
    },
    { asType: "generation" },
  );
}

async function callModel<T>(agent: string, prompt: string, schema: z.ZodType<T>): Promise<AgentResult<T>> {
  // Abort signal: after 20 seconds it fires and cancels the request.
  const signal = AbortSignal.timeout(AGENT_TIMEOUT_MS);
  const deadline = Date.now() + AGENT_TIMEOUT_MS;
  let failure: Failure = { status: null, reason: "unknown error", retryAfterMs: null, temporary: true };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await attemptCall(agent, prompt, schema, signal, attempt);
    if (result.ok) return result;
    if (result.timedOut) {
      console.warn(`  [${agent}] no answer within ${AGENT_TIMEOUT_MS / 1000} s`);
      return { ok: false, error: "Agent timeout", timedOut: true, temporary: true };
    }
    failure = result.failure;

    console.warn(`  [${agent}] attempt ${attempt} failed: ${describe(failure)}`);
    if (attempt === MAX_ATTEMPTS || !isRetryable(failure)) break;

    // If we would have to wait longer than the time left before the timeout, retrying is pointless.
    const wait = failure.retryAfterMs ?? RETRY_DELAY_MS * attempt;
    if (Date.now() + wait >= deadline) break;
    await sleep(wait);
  }

  return { ok: false, error: describe(failure), timedOut: false, temporary: failure.temporary };
}

// Cache: the file name is built from the request fingerprint. The same request to the same model
// gives the same file, and if the text or prompt changed, the file is different.
function cachePath(agent: string, prompt: string): string {
  const hash = createHash("sha256").update(MODEL + prompt).digest("hex").slice(0, 16);
  return path.join(CACHE_DIR, `${agent}-${hash}.json`);
}

async function readCache<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    // The cache file could have been edited by hand, so we check it with the schema too.
    const parsed = schema.safeParse(JSON.parse(await readFile(file, "utf-8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Runs an agent: takes the answer from the cache or asks the model
// and prepares a record for AgentRun (what the agent received and what it returned).
// In Langfuse an agent is a step of type agent, and the model call attempts are inside it.
export async function runAgent<T extends Prisma.InputJsonValue>(
  agent: string,
  prompt: string,
  input: Prisma.InputJsonValue,
  schema: z.ZodType<T>,
): Promise<AgentOutcome<T>> {
  return startActiveObservation(
    agent,
    async (span): Promise<AgentOutcome<T>> => {
      span.update({ input });
      const file = cachePath(agent, prompt);
      const cached = readFromCache ? await readCache(file, schema) : null;
      if (cached !== null) {
        console.log(`  [${agent}] from cache`);
        span.update({ output: cached, metadata: { cached: true, model: CACHE_MODEL } });
        return { result: { ok: true, data: cached }, run: { agent, model: CACHE_MODEL, input, output: cached } };
      }

      await waitForTurn();
      const result = await callModel(agent, prompt, schema);
      if (result.ok) {
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(file, JSON.stringify(result.data, null, 2), "utf-8");
      }
      const output = result.ok ? result.data : { error: result.error };
      span.update({ output, metadata: { cached: false, model: MODEL } });
      if (!result.ok) span.update({ level: "ERROR", statusMessage: result.error });
      return { result, run: { agent, model: MODEL, input, output } };
    },
    { asType: "agent" },
  );
}
