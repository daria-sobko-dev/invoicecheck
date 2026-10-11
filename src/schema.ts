import { z } from "zod";

// One invoice line: what was bought and how much it costs.
export const LineItemSchema = z.object({
  description: z.string(),
  amount: z.number(),
});

// The whole invoice. If the model did not find a value, it must return null.
export const InvoiceSchema = z.object({
  invoiceNumber: z.string().nullable(),
  date: z.string().nullable(), // format YYYY-MM-DD or null
  vendor: z.string().nullable(),
  currency: z.string().nullable(),
  total: z.number().nullable(),
  lineItems: z.array(LineItemSchema),
});

// The TypeScript type is inferred from the schema, so they never get out of sync.
export type Invoice = z.infer<typeof InvoiceSchema>;
