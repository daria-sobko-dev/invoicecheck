import { z } from "zod";
import type { Problem } from "../rules.js";
import type { Invoice } from "../schema.js";
import { runAgent, type AgentOutcome } from "./llm.js";

// Agent 3. Explains to a human why the invoice has problems.
// The answer contains only the explanation text, so it cannot change the numbers:
// the code simply does not take any data from its answer except this text.

export const ReconciliationSchema = z.object({
  explanation: z.string().min(1),
});
export type Reconciliation = z.infer<typeof ReconciliationSchema>;

const PROMPT = `You help a human reviewer understand problems in an invoice.
You get the data extracted from the invoice and the problems found by automatic checks.
Write a short explanation (1-3 sentences) of the most likely cause of the problems.
Rules:
- Never change, recalculate or suggest corrected numbers. Only explain.
- Base the explanation only on the data and problems given. Do not speculate about
  printing, scanning, typos or anything else that is not visible in the data.
- If the cause is unclear, say so.
Return ONLY a JSON object: { "explanation": string }

Data:
`;

export async function reconcile(invoice: Invoice, problems: Problem[]): Promise<AgentOutcome<Reconciliation>> {
  // Only the extracted data and the list of problems, without the PDF text.
  const input = { extracted: invoice, problems };
  return runAgent("reconciler", PROMPT + JSON.stringify(input, null, 2), input, ReconciliationSchema);
}
