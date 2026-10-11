import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { hashBytes, prisma } from "../db.js";
import { invoiceQueue } from "../queue.js";
import { InvoiceSchema } from "../schema.js";
import { protectedProcedure, router } from "./trpc.js";

// Document procedures: upload, get the result, get the list.

const UPLOAD_DIR = "storage/uploads";
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const PDF_MAGIC = "%PDF-"; // every real PDF starts like this

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/, "hash must be 64 hex characters (sha256)");
const StatusSchema = z.enum(["ok", "needs_review"]);

// --- documents.upload ---

const UploadInput = z.object({
  fileName: z.string().min(1).max(255),
  contentBase64: z.string().min(1),
});
const UploadOutput = z.object({
  hash: HashSchema,
  status: z.enum(["queued", "already_processed", "already_in_queue"]),
});

// base64 is a way to write file bytes as ordinary letters so they can be sent in JSON.
function decodeBase64(text: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "contentBase64 is not valid base64" });
  }
  // First estimate the size from the text length so we do not decode a huge file for nothing.
  if ((text.length / 4) * 3 > MAX_FILE_BYTES + 2) {
    throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "file is larger than 5 MB" });
  }
  return Buffer.from(text, "base64");
}

const upload = protectedProcedure
  .input(UploadInput)
  .output(UploadOutput)
  .mutation(async ({ input }) => {
    const bytes = decodeBase64(input.contentBase64);
    if (bytes.length > MAX_FILE_BYTES) {
      throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "file is larger than 5 MB" });
    }
    // Check the content, not the name: a renamed .txt will not pass.
    if (bytes.subarray(0, PDF_MAGIC.length).toString("latin1") !== PDF_MAGIC) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "file is not a PDF (must start with %PDF-)" });
    }

    const hash = hashBytes(bytes);

    // Already processed? Then do nothing.
    const existing = await prisma.document.findUnique({ where: { fileHash: hash }, select: { id: true } });
    if (existing !== null) return { hash, status: "already_processed" as const };

    // Already in the queue? Resend a failed job, leave the others alone.
    const job = await invoiceQueue.getJob(hash);
    if (job !== undefined) {
      if ((await job.getState()) === "failed") {
        await job.retry("failed", { resetAttemptsMade: true, resetAttemptsStarted: true });
        return { hash, status: "queued" as const };
      }
      return { hash, status: "already_in_queue" as const };
    }

    // New file: save it to disk and add a job. The worker will process it.
    await mkdir(UPLOAD_DIR, { recursive: true });
    const filePath = path.join(UPLOAD_DIR, `${hash}.pdf`);
    await writeFile(filePath, bytes);
    await invoiceQueue.add("invoice", { filePath, fileName: path.basename(input.fileName) }, { jobId: hash });
    return { hash, status: "queued" as const };
  });

// --- documents.getByHash ---

const AgentSummary = z.object({
  agent: z.string(),
  model: z.string(),
  createdAt: z.string(), // record time, ISO string
});

const GetByHashOutput = z.discriminatedUnion("state", [
  // The document is still in the queue: show the job state.
  z.object({
    state: z.literal("queued"),
    hash: HashSchema,
    jobStatus: z.enum(["waiting", "active", "failed"]),
    attemptsMade: z.number().int(),
    failedReason: z.string().nullable(),
  }),
  // The document is processed: result from the database.
  z.object({
    state: z.literal("processed"),
    hash: HashSchema,
    fileName: z.string(),
    status: StatusSchema,
    extracted: InvoiceSchema.nullable(),
    violations: z.array(z.object({ rule: z.string(), message: z.string() })),
    explanation: z.string().nullable(),
    agents: z.array(AgentSummary),
  }),
]);

const getByHash = protectedProcedure
  .input(z.object({ hash: HashSchema }))
  .output(GetByHashOutput)
  .query(async ({ input }) => {
    const doc = await prisma.document.findUnique({
      where: { fileHash: input.hash },
      include: {
        violations: { select: { rule: true, message: true }, orderBy: { id: "asc" } },
        agentRuns: { select: { agent: true, model: true, createdAt: true }, orderBy: { id: "asc" } },
      },
    });

    if (doc !== null) {
      return {
        state: "processed" as const,
        hash: input.hash,
        fileName: doc.fileName,
        // In the database these are just a string and JSON, so we check them with schemas.
        status: StatusSchema.parse(doc.status),
        extracted: InvoiceSchema.nullable().parse(doc.extracted),
        violations: doc.violations,
        explanation: doc.explanation,
        agents: doc.agentRuns.map((run) => ({ ...run, createdAt: run.createdAt.toISOString() })),
      };
    }

    const job = await invoiceQueue.getJob(input.hash);
    if (job === undefined) {
      throw new TRPCError({ code: "NOT_FOUND", message: "no document and no job with this hash" });
    }
    const state = await job.getState();
    if (state === "completed") {
      // The job finished but the document is not in the database (for example, the database was cleared separately).
      throw new TRPCError({ code: "NOT_FOUND", message: "job is completed but the document is not in the database" });
    }
    return {
      state: "queued" as const,
      hash: input.hash,
      // delayed (pause before a retry) and other waits are just "waiting" for the client.
      jobStatus: state === "active" || state === "failed" ? state : ("waiting" as const),
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason ?? null,
    };
  });

// --- documents.list ---

const ListInput = z.object({
  status: StatusSchema.optional(),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.number().int().positive().optional(), // id of the document to continue after
});

const ListOutput = z.object({
  items: z.array(
    z.object({
      id: z.number().int(),
      hash: HashSchema,
      fileName: z.string(),
      status: StatusSchema,
      problemCount: z.number().int(),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.number().int().nullable(), // null means "no more pages"
});

const list = protectedProcedure
  .input(ListInput)
  .output(ListOutput)
  .query(async ({ input }) => {
    // Take one extra record to find out whether there is a next page.
    const rows = await prisma.document.findMany({
      where: {
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.cursor !== undefined ? { id: { lt: input.cursor } } : {}),
      },
      orderBy: { id: "desc" },
      take: input.limit + 1,
      include: { _count: { select: { violations: true } } },
    });
    const page = rows.slice(0, input.limit);
    return {
      items: page.map((doc) => ({
        id: doc.id,
        hash: doc.fileHash,
        fileName: doc.fileName,
        status: StatusSchema.parse(doc.status),
        problemCount: doc._count.violations,
        createdAt: doc.createdAt.toISOString(),
      })),
      nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    };
  });

export const documentsRouter = router({ upload, getByHash, list });
