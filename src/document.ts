import { getActiveTraceId, propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { readPdfText } from "./pdf.js";
import { processText, type ProcessResult } from "./pipeline.js";

// Processing of one whole PDF. One document = one trace in Langfuse named after the file.
// Inside the trace: the readPdfText step, the agent steps and the rules step.

export type AnalyzeOptions = {
  source: "index" | "worker" | "eval"; // who started it: goes into the trace tags
  metadata?: Record<string, string>; // for example the job attempt number in the worker
};

export type Analysis = {
  result: ProcessResult;
  traceId: string | undefined; // trace id in Langfuse, eval needs it for scores
};

// Tags for searching in Langfuse: status and special cases.
function resultTags(result: ProcessResult): string[] {
  const tags: string[] = [result.status];
  const rules = new Set(result.problems.map((p) => p.rule));
  if (rules.has("pdfHasText")) tags.push("scan");
  if (rules.has("documentType")) tags.push("not_invoice");
  if (rules.has("fieldConfidence")) tags.push("low_confidence");
  if (rules.has("agentTimeout")) tags.push("agent_timeout");
  if (rules.has("agentFailed")) tags.push("agent_error");
  return tags;
}

export async function analyzeFile(filePath: string, fileName: string, options: AnalyzeOptions): Promise<Analysis> {
  return startActiveObservation(fileName, (root) =>
    // traceName and tags are set for all steps inside this trace.
    propagateAttributes(
      { traceName: fileName, tags: [options.source], metadata: { source: options.source, ...options.metadata } },
      async (): Promise<Analysis> => {
        root.update({ input: { filePath } });

        // Step 1: text from the PDF.
        const pdf = await startActiveObservation("readPdfText", async (span) => {
          span.update({ input: { filePath } });
          const read = await readPdfText(filePath);
          span.update(
            read.ok
              ? { output: { chars: read.text.length } }
              : { output: { error: read.error }, level: "WARNING", statusMessage: read.error },
          );
          return read;
        });

        // Step 2: agents and rules. No text means we do not call the agents.
        const result: ProcessResult = pdf.ok
          ? await processText(pdf.text)
          : {
              status: "needs_review",
              extracted: null,
              problems: [{ rule: "pdfHasText", message: pdf.error }],
              explanation: null,
              runs: [],
            };

        // Trace result: status, number of problems, tags. They are visible in the trace list.
        propagateAttributes(
          {
            tags: resultTags(result),
            metadata: { status: result.status, problemCount: String(result.problems.length) },
          },
          () => undefined,
        );
        root.update({
          output: {
            status: result.status,
            problems: result.problems.map((p) => p.message),
            explanation: result.explanation,
          },
          level: result.agentFailure !== undefined ? "ERROR" : "DEFAULT",
        });

        return { result, traceId: getActiveTraceId() };
      },
    ),
  );
}
