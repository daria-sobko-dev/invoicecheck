import { z } from "zod";
import { ConfidenceSchema, runAgent, type AgentOutcome } from "./llm.js";

// Agent 1. Determines the document type. Does nothing else.

// The beginning of the document is enough to tell the type, the whole text is not needed.
const MAX_TEXT_CHARS = 2000;

export const ClassificationSchema = z.object({
  type: z.enum(["invoice", "bank_statement", "other"]),
  confidence: ConfidenceSchema,
});
export type Classification = z.infer<typeof ClassificationSchema>;

const PROMPT = `You classify financial documents.
Return ONLY a JSON object: { "type": "invoice" | "bank_statement" | "other", "confidence": number }
- "invoice": a bill from a seller asking to pay for goods or services.
- "bank_statement": a list of account transactions issued by a bank.
- "other": anything else.
"confidence" is a number from 0 to 1: how sure you are about the type.

Document text:
`;

export async function classify(text: string): Promise<AgentOutcome<Classification>> {
  const input = { text: text.slice(0, MAX_TEXT_CHARS) };
  return runAgent("classifier", PROMPT + input.text, input, ClassificationSchema);
}
