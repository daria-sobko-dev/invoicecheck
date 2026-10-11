import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { prisma } from "../db.js";
import { closeQueue } from "../queue.js";
import { appRouter } from "./router.js";
import { createContext } from "./trpc.js";

// HTTP server for the API. Run: npm run api

const PORT = 3000;
// A PDF of up to 5 MB takes about 6.7 MB in base64, plus a bit for the JSON around it.
// If the request is bigger, tRPC itself answers PAYLOAD_TOO_LARGE without reading it fully.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

if (!process.env.API_KEY) {
  throw new Error("API_KEY not found in .env");
}

const server = createHTTPServer({
  router: appRouter,
  createContext,
  maxBodySize: MAX_BODY_BYTES,
  onError({ path, error }) {
    // Print only unexpected server errors, not "wrong key" or "not a PDF".
    if (error.code === "INTERNAL_SERVER_ERROR") {
      console.error(`error in ${path ?? "?"}: ${error.message}`);
    }
  },
});

server.listen(PORT);
console.log(`API started: http://localhost:${PORT}  (Ctrl+C to exit)`);

// Ctrl+C: stop accepting requests and close connections.
async function shutdown(): Promise<void> {
  console.log("\nshutting down API...");
  server.close();
  await closeQueue();
  await prisma.$disconnect();
  console.log("API stopped");
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
