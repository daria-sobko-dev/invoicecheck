import { rm } from "node:fs/promises";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "../src/api/documents.js";
import { appRouter } from "../src/api/router.js";
import { createCallerFactory } from "../src/api/trpc.js";
import { hashBytes, prisma } from "../src/db.js";
import { closeQueue, invoiceQueue, QUEUE_NAME } from "../src/queue.js";

// API tests without HTTP and without Gemini: procedures are called directly via createCaller.
// Postgres and Redis must be running (docker compose up -d).

const KEY = "test-api-key";
const createCaller = createCallerFactory(appRouter);
const api = createCaller({ apiKey: KEY });
const anonymous = createCaller({ apiKey: null });
const wrongKey = createCaller({ apiKey: "wrong" });

// A tiny "PDF": a correct file start is enough to test the API.
const fakePdf = Buffer.from("%PDF-1.4\n% InvoiceCheck API test file\n%%EOF\n");
const fakePdfHash = hashBytes(fakePdf);
const asBase64 = (bytes: Buffer): string => bytes.toString("base64");

// tRPC error code, or "no error" if there was no error.
async function errorCode(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return "no error";
  } catch (err) {
    return err instanceof TRPCError ? err.code : String(err);
  }
}

beforeAll(async () => {
  process.env.API_KEY = KEY;
  // Safety: tests only work with the test queue, the real one is not touched.
  expect(QUEUE_NAME).toBe("invoices-test");
  await invoiceQueue.obliterate({ force: true });
});

afterAll(async () => {
  await invoiceQueue.obliterate({ force: true });
  await rm(`storage/uploads/${fakePdfHash}.pdf`, { force: true });
  await closeQueue();
  await prisma.$disconnect();
});

describe("protection and key", () => {
  it("health works without a key and sees Postgres and Redis", async () => {
    expect(await anonymous.health()).toEqual({ ok: true, postgres: true, redis: true });
  });

  it("no key: UNAUTHORIZED", async () => {
    const call = anonymous.documents.upload({ fileName: "a.pdf", contentBase64: asBase64(fakePdf) });
    expect(await errorCode(call)).toBe("UNAUTHORIZED");
  });

  it("wrong key: UNAUTHORIZED", async () => {
    expect(await errorCode(wrongKey.queue.stats())).toBe("UNAUTHORIZED");
  });
});

describe("documents.upload", () => {
  it("not a PDF (text renamed to .pdf): BAD_REQUEST", async () => {
    const text = Buffer.from("INVOICE\nInvoice No: INV-1\nTOTAL (EUR) 100.00\n");
    const call = api.documents.upload({ fileName: "fake.pdf", contentBase64: asBase64(text) });
    expect(await errorCode(call)).toBe("BAD_REQUEST");
  });

  it("not base64: BAD_REQUEST", async () => {
    const call = api.documents.upload({ fileName: "a.pdf", contentBase64: "this is not base64!" });
    expect(await errorCode(call)).toBe("BAD_REQUEST");
  });

  it("larger than 5 MB: PAYLOAD_TOO_LARGE", async () => {
    const big = Buffer.alloc(MAX_FILE_BYTES + 1, 0x20);
    big.write("%PDF-");
    const call = api.documents.upload({ fileName: "big.pdf", contentBase64: asBase64(big) });
    expect(await errorCode(call)).toBe("PAYLOAD_TOO_LARGE");
  });

  it("uploading the same file again does not create a second job", async () => {
    const input = { fileName: "test.pdf", contentBase64: asBase64(fakePdf) };
    expect(await api.documents.upload(input)).toEqual({ hash: fakePdfHash, status: "queued" });

    const second = await api.documents.upload(input);
    expect(second.hash).toBe(fakePdfHash);
    expect(["already_in_queue", "already_processed"]).toContain(second.status);

    const counts = await api.queue.stats();
    expect(counts.waiting + counts.active + counts.delayed).toBe(1);
  });
});

describe("documents.getByHash", () => {
  it("file in queue: state queued, job is waiting", async () => {
    const doc = await api.documents.getByHash({ hash: fakePdfHash });
    expect(doc).toMatchObject({ state: "queued", hash: fakePdfHash, jobStatus: "waiting" });
  });

  it("unknown hash: NOT_FOUND", async () => {
    expect(await errorCode(api.documents.getByHash({ hash: "0".repeat(64) }))).toBe("NOT_FOUND");
  });

  it("malformed hash: BAD_REQUEST (input checked by schema)", async () => {
    expect(await errorCode(api.documents.getByHash({ hash: "abc" }))).toBe("BAD_REQUEST");
  });
});

describe("documents.list", () => {
  it("limit above 50: BAD_REQUEST", async () => {
    expect(await errorCode(api.documents.list({ limit: 51 }))).toBe("BAD_REQUEST");
  });

  it("pagination: pages do not overlap", async () => {
    const first = await api.documents.list({ limit: 2 });
    expect(first.items.length).toBeLessThanOrEqual(2);
    if (first.nextCursor !== null) {
      const second = await api.documents.list({ limit: 2, cursor: first.nextCursor });
      const firstIds = first.items.map((d) => d.id);
      expect(second.items.every((d) => !firstIds.includes(d.id))).toBe(true);
    }
  });
});

describe("Gemini protection in tests", () => {
  it("model call code does not load without a key", async () => {
    await expect(import("../src/agents/llm.js")).rejects.toThrow("GEMINI_API_KEY");
  });
});
