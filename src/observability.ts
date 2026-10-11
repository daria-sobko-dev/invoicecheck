import "dotenv/config";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { withTimeout } from "./timeout.js";

// Observability: sending traces to Langfuse.
// This file must be imported first in every command (index, worker, eval),
// so that tracing is on before the first step.
//
// Main rule: observability must not break processing.
// No keys or Langfuse is unavailable means we work as before, just without traces.

const SHUTDOWN_TIMEOUT_MS = 10_000; // we will not wait longer than this for traces to be sent on exit

export const tracingEnabled = Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

let sdk: NodeSDK | null = null;

if (tracingEnabled) {
  try {
    // LangfuseSpanProcessor collects steps and sends them to Langfuse in batches.
    // It reads the keys and address by itself from LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL.
    sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
    sdk.start();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`Langfuse: failed to enable tracing (${reason}), working without it`);
    sdk = null;
  }
} else {
  console.log("Langfuse: no keys, tracing is off");
}

// Sends the collected traces and turns tracing off. Call it before exiting,
// otherwise the last traces that are still in memory will be lost.
export async function shutdownTracing(): Promise<void> {
  if (sdk === null) return;
  try {
    await withTimeout(sdk.shutdown(), SHUTDOWN_TIMEOUT_MS);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`Langfuse: failed to send traces (${reason})`);
  }
}
