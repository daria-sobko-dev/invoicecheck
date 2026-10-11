import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createTRPCClient, httpLink, isTRPCClientError } from "@trpc/client";
// "import type": take only TYPES from the server, server code does not get into the client.
import type { AppRouter } from "./api/router.js";

// Client: uploads a PDF through the API and waits for the result.
// Run: npm run client -- samples/pdf/invoice-ok.pdf

const API_URL = "http://localhost:3000";
const POLL_EVERY_MS = 2000;
const POLL_LIMIT_MS = 3 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const filePath = process.argv[2];
if (!filePath) {
  console.error("specify a file: npm run client -- samples/pdf/invoice-ok.pdf");
  process.exit(1);
}

// The client knows all procedures, their inputs and outputs thanks to the AppRouter type.
const api = createTRPCClient<AppRouter>({
  links: [httpLink({ url: API_URL, headers: { "x-api-key": process.env.API_KEY ?? "" } })],
});

try {
  // 1. Upload.
  const content = await readFile(filePath);
  const uploaded = await api.documents.upload.mutate({
    fileName: path.basename(filePath),
    contentBase64: content.toString("base64"),
  });
  console.log(`uploaded: ${path.basename(filePath)} → ${uploaded.status} [${uploaded.hash.slice(0, 8)}]`);

  // 2. Polling: every 2 seconds we ask whether it is ready.
  const startedAt = Date.now();
  let lastStatus = "";
  for (;;) {
    const doc = await api.documents.getByHash.query({ hash: uploaded.hash });

    if (doc.state === "processed") {
      // Here TypeScript knows that doc has status, violations, explanation, agents.
      console.log(`\ndone: status = ${doc.status}`);
      if (doc.extracted !== null) {
        const e = doc.extracted;
        console.log(`  invoice ${e.invoiceNumber ?? "?"} dated ${e.date ?? "?"}, ${e.vendor ?? "?"}, total ${e.total ?? "?"} ${e.currency ?? ""}`);
      }
      for (const v of doc.violations) console.log(`  - [${v.rule}] ${v.message}`);
      if (doc.explanation !== null) console.log(`  explanation: ${doc.explanation}`);
      console.log(`  agents: ${doc.agents.map((a) => `${a.agent} (${a.model})`).join(", ") || "none called"}`);
      break;
    }

    // Still in the queue: print the state only when it changes.
    const status = `${doc.jobStatus}, attempts: ${doc.attemptsMade}`;
    if (status !== lastStatus) {
      console.log(`  in queue: ${status}${doc.failedReason ? ` (${doc.failedReason})` : ""}`);
      lastStatus = status;
    }
    if (doc.jobStatus === "failed") {
      console.log("job failed, details: npm run failed");
      process.exit(1);
    }
    if (Date.now() - startedAt > POLL_LIMIT_MS) {
      console.log("waited 3 minutes, no result. Is the worker running (npm run worker)?");
      process.exit(1);
    }
    await sleep(POLL_EVERY_MS);
  }
} catch (err) {
  // API errors come with a clear code: BAD_REQUEST, UNAUTHORIZED, etc.
  if (isTRPCClientError(err)) {
    console.error(`API error: ${err.data?.code ?? "?"}: ${err.message}`);
  } else {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}
