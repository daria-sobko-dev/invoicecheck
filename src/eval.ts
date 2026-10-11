// First: turns on Langfuse tracing before any steps.
import { shutdownTracing, tracingEnabled } from "./observability.js";
import { withTimeout } from "./timeout.js";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { LangfuseClient } from "@langfuse/client";
import { z } from "zod";
import { configureModelCalls } from "./agents/llm.js";
import { analyzeFile } from "./document.js";
import type { ProcessResult } from "./pipeline.js";

// Eval: runs PDFs through the pipeline WITHOUT saving to the database and compares with evals/expected.json.
// Run:    npm run eval                      all files, answers from cache
//         npm run eval -- --fresh           ask the model again
//         npm run eval -- a.pdf b.pdf       only these files

const PDF_DIR = "samples/pdf";
const EXPECTED_FILE = "evals/expected.json";
const PAUSE_BETWEEN_CALLS_MS = 15_000; // no more than 4 model requests per minute

// Expected answers are also checked with a schema: a typo in the JSON must not silently break the eval.
const ExpectedSchema = z.record(
  z.string(),
  z.object({
    status: z.enum(["ok", "needs_review"]),
    invoiceNumber: z.string().nullable(),
    total: z.number().nullable(),
    currency: z.string().nullable(),
    date: z.string().nullable(),
    rules: z.array(z.string()),
  }),
);
type Expected = z.infer<typeof ExpectedSchema>[string];

// One table row.
type Row = { file: string; field: string; expected: string; actual: string; match: boolean };

function show(value: string | number | null): string {
  return value === null ? "null" : String(value);
}

// "1,370.00" -> 1370, "1.225,50" -> 1225.5, "2026" -> 2026.
// If there are 1-2 digits after the last separator, they are cents, otherwise it is a thousands separator.
function toNumber(raw: string): number {
  const match = raw.match(/^(.*)[.,](\d{1,2})$/);
  if (match) return Number(`${match[1]!.replace(/[.,]/g, "")}.${match[2]}`);
  return Number(raw.replace(/[.,]/g, ""));
}

function numbersIn(text: string): number[] {
  return (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map(toNumber);
}

// Hallucination check: every number in the explanation must be in the data or the problems.
function inventedNumbers(result: ProcessResult): number[] {
  if (result.explanation === null) return [];
  const allowed = new Set(numbersIn(JSON.stringify(result.extracted) + JSON.stringify(result.problems)));
  return [...new Set(numbersIn(result.explanation))].filter((n) => !allowed.has(n));
}

function compare(file: string, expected: Expected, result: ProcessResult): Row[] {
  const got = result.extracted;
  const row = (field: string, exp: string, act: string): Row => ({ file, field, expected: exp, actual: act, match: exp === act });
  const rules = (list: string[]): string => [...new Set(list)].sort().join(", ") || "—";

  return [
    row("status", expected.status, result.status),
    row("invoiceNumber", show(expected.invoiceNumber), show(got?.invoiceNumber ?? null)),
    row("total", show(expected.total), show(got?.total ?? null)),
    row("currency", show(expected.currency), show(got?.currency ?? null)),
    row("date", show(expected.date), show(got?.date ?? null)),
    row("rules", rules(expected.rules), rules(result.problems.map((p) => p.rule))),
  ];
}

function printTable(rows: Row[]): void {
  const headers = ["file", "field", "expected", "actual", ""];
  const cells = rows.map((r) => [r.file, r.field, r.expected, r.actual, r.match ? "✓" : "✗"]);
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]): string => c.map((v, i) => v.padEnd(widths[i]!)).join(" │ ");
  console.log(line(headers));
  console.log(widths.map((w) => "─".repeat(w)).join("─┼─"));
  let lastFile = "";
  for (const c of cells) {
    // Print the file name only once, in its first row.
    const shown = c[0] === lastFile ? "" : c[0]!;
    lastFile = c[0]!;
    console.log(line([shown, ...c.slice(1)]));
  }
}

function percent(part: number, total: number): string {
  return total === 0 ? "—" : `${Math.round((part / total) * 100)}% (${part}/${total})`;
}

// --- run ---

const args = process.argv.slice(2);
const fresh = args.includes("--fresh");
const onlyFiles = args.filter((a) => !a.startsWith("--"));

configureModelCalls({ readFromCache: !fresh, pauseBetweenCallsMs: PAUSE_BETWEEN_CALLS_MS });

const expected = ExpectedSchema.parse(JSON.parse(await readFile(EXPECTED_FILE, "utf-8")));
const files = (await readdir(PDF_DIR))
  .filter((name) => name.toLowerCase().endsWith(".pdf"))
  .filter((name) => onlyFiles.length === 0 || onlyFiles.includes(name))
  .sort();

// Send scores only if Langfuse keys are present.
const langfuse = tracingEnabled ? new LangfuseClient() : null;

console.log(`eval: ${files.length} files, ${fresh ? "calling the model again (--fresh)" : "answers from cache"}`);

const rows: Row[] = [];
const hallucinationRows: Row[] = [];

for (const fileName of files) {
  const exp = expected[fileName];
  if (exp === undefined) {
    console.log(`\n${fileName}: no expected answers in ${EXPECTED_FILE}, skipping`);
    continue;
  }
  console.log(`\n${fileName}`);
  const { result, traceId } = await analyzeFile(path.join(PDF_DIR, fileName), fileName, { source: "eval" });

  const fileRows = compare(fileName, exp, result);
  rows.push(...fileRows);

  const invented = inventedNumbers(result);
  if (result.explanation !== null) {
    hallucinationRows.push({
      file: fileName,
      field: "numbers in explanation",
      expected: "only from data",
      actual: invented.length === 0 ? "only from data" : `invented: ${invented.join(", ")}`,
      match: invented.length === 0,
    });
  }

  // Scores in Langfuse: attach them to this document's trace.
  if (langfuse !== null && traceId !== undefined) {
    const fieldRows = fileRows.filter((r) => r.field !== "status");
    langfuse.score.create({
      traceId,
      name: "eval_fields",
      value: fieldRows.filter((r) => r.match).length / fieldRows.length,
      dataType: "NUMERIC",
      comment: fieldRows.filter((r) => !r.match).map((r) => `${r.field}: expected ${r.expected}, got ${r.actual}`).join("; ") || "all matched",
    });
    langfuse.score.create({ traceId, name: "eval_status", value: fileRows[0]!.match ? 1 : 0, dataType: "BOOLEAN" });
    if (result.explanation !== null) {
      langfuse.score.create({
        traceId,
        name: "eval_no_invented_numbers",
        value: invented.length === 0 ? 1 : 0,
        dataType: "BOOLEAN",
        comment: invented.length === 0 ? undefined : `invented: ${invented.join(", ")}`,
      });
    }
  }
}

console.log("\n=== Comparison with expected.json ===\n");
printTable(rows);

if (hallucinationRows.length > 0) {
  console.log("\n=== Hallucination check (Reconciler) ===\n");
  printTable(hallucinationRows);
}

const fieldRows = rows.filter((r) => r.field !== "status");
const statusRows = rows.filter((r) => r.field === "status");
console.log("\n=== Summary ===");
console.log(`fields: ${percent(fieldRows.filter((r) => r.match).length, fieldRows.length)}`);
console.log(`status: ${percent(statusRows.filter((r) => r.match).length, statusRows.length)}`);
console.log(`hallucinations in explanations: ${hallucinationRows.filter((r) => !r.match).length} of ${hallucinationRows.length}`);

// Send scores and traces. A Langfuse error must not break the eval.
if (langfuse !== null) {
  try {
    await withTimeout(langfuse.shutdown(), 10_000);
  } catch (err) {
    console.warn(`Langfuse: failed to send scores (${err instanceof Error ? err.message : String(err)})`);
  }
}
await shutdownTracing();

// If Langfuse is unavailable, its library keeps retrying for about a minute
// and does not let the program exit. Everything is already computed and printed, so we exit explicitly.
process.exit(0);
