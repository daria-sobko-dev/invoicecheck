import { z } from "zod";
import { InvoiceSchema, type Invoice } from "../schema.js";
import type { Classification } from "./classifier.js";
import { ConfidenceSchema, runAgent, type AgentOutcome } from "./llm.js";

// Agent 2. Extracts the invoice fields and says how confident it is about each field.

// A field with confidence: { "value": ..., "confidence": 0.95 }.
function withConfidence<T extends z.ZodType>(value: T) {
  return z.object({ value, confidence: ConfidenceSchema });
}

// Values are checked with the same invoice schema as before.
const field = InvoiceSchema.shape;
export const ExtractionSchema = z.object({
  invoiceNumber: withConfidence(field.invoiceNumber),
  date: withConfidence(field.date),
  vendor: withConfidence(field.vendor),
  currency: withConfidence(field.currency),
  total: withConfidence(field.total),
  lineItems: withConfidence(field.lineItems),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

// Confidence for each invoice field.
export type FieldConfidence = Record<keyof Invoice, number>;

const PROMPT = `You extract data from invoices.
Return ONLY a JSON object, no markdown, no explanations.
Every field is an object { "value": ..., "confidence": number from 0 to 1 }:
{
  "invoiceNumber": { "value": string | null, "confidence": number },
  "date":          { "value": string | null, "confidence": number },  // value format YYYY-MM-DD
  "vendor":        { "value": string | null, "confidence": number },  // the company that issued the invoice
  "currency":      { "value": string | null, "confidence": number },  // ISO code, e.g. "EUR"
  "total":         { "value": number | null, "confidence": number },  // the total exactly as written
  "lineItems":     { "value": [{ "description": string, "amount": number }], "confidence": number }
}
Rules:
- If a value is not present in the text, use null. Never guess or invent values.
- Copy numbers exactly as written. Do not recalculate or fix the total.
- "confidence" says how sure you are that the value is read correctly.
  Use a low confidence if the text is unclear, ambiguous or you had to interpret it.
- If the value is null because the field is absent, "confidence" says how sure you are
  that it is really absent from the text.

Invoice text:
`;

export async function extract(text: string, classification: Classification): Promise<AgentOutcome<Extraction>> {
  // Take the previous agent's result: the extractor works only with invoices.
  const input = { documentType: classification.type, text };
  return runAgent("extractor", PROMPT + text, input, ExtractionSchema);
}

// Splits the answer into the invoice itself and the per-field confidence.
export function splitConfidence(extraction: Extraction): { invoice: Invoice; confidence: FieldConfidence } {
  return {
    invoice: {
      invoiceNumber: extraction.invoiceNumber.value,
      date: extraction.date.value,
      vendor: extraction.vendor.value,
      currency: extraction.currency.value,
      total: extraction.total.value,
      lineItems: extraction.lineItems.value,
    },
    confidence: {
      invoiceNumber: extraction.invoiceNumber.confidence,
      date: extraction.date.confidence,
      vendor: extraction.vendor.confidence,
      currency: extraction.currency.confidence,
      total: extraction.total.confidence,
      lineItems: extraction.lineItems.confidence,
    },
  };
}
