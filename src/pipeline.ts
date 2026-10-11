import { startActiveObservation } from "@langfuse/tracing";
import { classify } from "./agents/classifier.js";
import { extract, splitConfidence } from "./agents/extractor.js";
import type { AgentFailure, AgentRunToSave } from "./agents/llm.js";
import { reconcile } from "./agents/reconciler.js";
import { checkConfidence, checkInvoice, type InvoiceStatus, type Problem } from "./rules.js";
import type { Invoice } from "./schema.js";

export type ProcessResult = {
  status: InvoiceStatus;
  extracted: Invoice | null;
  problems: Problem[];
  explanation: string | null;
  runs: AgentRunToSave[]; // records for AgentRun, one per agent that was called
  // Present only if an agent failed. The worker uses it to decide whether to retry the job.
  agentFailure?: { problem: Problem; temporary: boolean };
};

// The agent did not answer in time or answered with an error. We do not fill in any values.
function agentProblem(agent: string, failure: AgentFailure): Problem {
  return failure.timedOut
    ? { rule: "agentTimeout", message: `Agent timeout (${agent})` }
    : { rule: "agentFailed", message: `Agent ${agent} failed: ${failure.error}` };
}

// One console line per step: "  → Classifier: invoice (0.98)".
function logStep(step: string, message: string): void {
  console.log(`  → ${step}: ${message}`);
}

function failureText(failure: AgentFailure): string {
  return failure.timedOut ? "no answer within 20 s" : `error (${failure.error})`;
}

// 1 problem, 2 problems, 0 problems.
function problemsWord(count: number): string {
  return count === 1 ? "problem" : "problems";
}

// How many invoice fields the model found: null and an empty list do not count.
function countFoundFields(invoice: Invoice): number {
  return Object.values(invoice).filter((value) => {
    if (value === null) return false;
    return !Array.isArray(value) || value.length > 0;
  }).length;
}

// A document goes through the agent chain: classifier -> extractor -> rules -> reconciler.
export async function processText(text: string): Promise<ProcessResult> {
  const runs: AgentRunToSave[] = [];
  const needsReview = (problem: Problem): ProcessResult => ({
    status: "needs_review",
    extracted: null,
    problems: [problem],
    explanation: null,
    runs,
  });
  const agentFailed = (agent: string, failure: AgentFailure): ProcessResult => {
    const problem = agentProblem(agent, failure);
    return { ...needsReview(problem), agentFailure: { problem, temporary: failure.temporary } };
  };

  // 1. Classifier: what kind of document is this?
  const classified = await classify(text);
  runs.push(classified.run);
  if (!classified.result.ok) {
    logStep("Classifier", failureText(classified.result));
    logStep("Extractor", "skipped, document type is unknown");
    logStep("Rules", "skipped, nothing to check");
    logStep("Reconciler", "skipped, nothing to explain");
    return agentFailed("classifier", classified.result);
  }

  const { type, confidence: typeConfidence } = classified.result.data;
  logStep("Classifier", `${type} (${typeConfidence})`);
  if (type !== "invoice") {
    logStep("Extractor", `skipped, this is not an invoice (${type})`);
    logStep("Rules", "skipped, nothing to check");
    logStep("Reconciler", "skipped, nothing to explain");
    return needsReview({ rule: "documentType", message: `Not an invoice: ${type}` });
  }

  // 2. Extractor: get the invoice fields and the confidence for each field.
  const extracted = await extract(text, classified.result.data);
  runs.push(extracted.run);
  if (!extracted.result.ok) {
    logStep("Extractor", failureText(extracted.result));
    logStep("Rules", "skipped, no invoice data");
    logStep("Reconciler", "skipped, nothing to explain");
    return agentFailed("extractor", extracted.result);
  }

  const { invoice, confidence } = splitConfidence(extracted.result.data);
  const fieldCount = Object.keys(invoice).length;
  const minConfidence = Math.min(...Object.values(confidence));
  logStep("Extractor", `found ${countFoundFields(invoice)} of ${fieldCount} fields, min. confidence ${minConfidence}`);

  // 3. Rules in code: confidence, totals, dates, currency.
  // In Langfuse this is a separate step "rules": what was checked and which problems were found.
  const problems = startActiveObservation("rules", (span) => {
    span.update({ input: { extracted: invoice, confidence } });
    const found = [...checkConfidence(confidence), ...checkInvoice(invoice).problems];
    span.update({ output: { problems: found }, level: found.length > 0 ? "WARNING" : "DEFAULT" });
    return found;
  });
  if (problems.length === 0) {
    logStep("Rules", "no problems");
    logStep("Reconciler", "skipped, no problems");
    return { status: "ok", extracted: invoice, problems, explanation: null, runs };
  }
  logStep("Rules", `${problems.length} ${problemsWord(problems.length)}`);

  // 4. Reconciler: explains the problems to a human. It does not touch the numbers.
  const reconciled = await reconcile(invoice, problems);
  runs.push(reconciled.run);
  if (reconciled.result.ok) {
    logStep("Reconciler", "explanation ready");
    return {
      status: "needs_review",
      extracted: invoice,
      problems,
      explanation: reconciled.result.data.explanation,
      runs,
    };
  }

  logStep("Reconciler", failureText(reconciled.result));
  const problem = agentProblem("reconciler", reconciled.result);
  return {
    status: "needs_review",
    extracted: invoice,
    problems: [...problems, problem],
    explanation: null,
    runs,
    agentFailure: { problem, temporary: reconciled.result.temporary },
  };
}
