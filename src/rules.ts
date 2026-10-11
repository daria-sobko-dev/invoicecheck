import type { Invoice } from "./schema.js";

// A check receives an invoice. If everything is fine, it returns null,
// otherwise it returns the problem text.
type Rule = (invoice: Invoice) => string | null;

export type InvoiceStatus = "ok" | "needs_review";

// A problem: which rule fired and what it said.
export type Problem = {
  rule: string;
  message: string;
};

export type CheckResult = {
  status: InvoiceStatus;
  problems: Problem[];
};

const KNOWN_CURRENCIES = ["EUR", "USD", "UAH"];
const ROUNDING_TOLERANCE = 0.01;

// Round to cents so that it prints 1370, not 1369.9999999998.
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// Today's date as "YYYY-MM-DD" in local time.
function todayString(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export const totalMatchesLineItems: Rule = (invoice) => {
  if (invoice.total === null) return null; // that is a problem for totalIsPositive
  const sum = invoice.lineItems.reduce((acc, item) => acc + item.amount, 0);
  // The difference is computed by code, not by the model. Plus: total is greater than the sum of lines, minus: less.
  const difference = round2(invoice.total - sum);
  if (Math.abs(difference) > ROUNDING_TOLERANCE) {
    return `Line items sum to ${round2(sum)}, but total is ${invoice.total} (difference: ${difference})`;
  }
  return null;
};

export const dateIsPresent: Rule = (invoice) => {
  return invoice.date === null ? "Invoice date is missing" : null;
};

export const dateNotInFuture: Rule = (invoice) => {
  if (invoice.date === null) return null; // that is a problem for dateIsPresent
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoice.date)) {
    return `Date "${invoice.date}" is not in YYYY-MM-DD format`;
  }
  // Dates in YYYY-MM-DD format can be compared as plain strings.
  if (invoice.date > todayString()) {
    return `Date ${invoice.date} is in the future`;
  }
  return null;
};

export const currencyIsKnown: Rule = (invoice) => {
  if (invoice.currency === null) return "Currency is missing";
  if (!KNOWN_CURRENCIES.includes(invoice.currency)) {
    return `Unknown currency "${invoice.currency}", expected one of ${KNOWN_CURRENCIES.join(", ")}`;
  }
  return null;
};

export const totalIsPositive: Rule = (invoice) => {
  if (invoice.total === null) return "Total is missing";
  return invoice.total > 0 ? null : `Total must be positive, but it is ${invoice.total}`;
};

// The key is the rule name: it goes into the database, into the Violation table.
const RULES: Record<string, Rule> = {
  totalMatchesLineItems,
  dateIsPresent,
  dateNotInFuture,
  currencyIsKnown,
  totalIsPositive,
};

export function checkInvoice(invoice: Invoice): CheckResult {
  const problems: Problem[] = [];
  for (const [rule, check] of Object.entries(RULES)) {
    const message = check(invoice);
    if (message !== null) problems.push({ rule, message });
  }
  return {
    status: problems.length === 0 ? "ok" : "needs_review",
    problems,
  };
}

const MIN_CONFIDENCE = 0.8;

// If the model itself is not sure about a field, that value cannot be considered verified:
// the document goes to a human, even if all other rules passed.
export function checkConfidence(confidence: Record<string, number>): Problem[] {
  const problems: Problem[] = [];
  for (const [field, value] of Object.entries(confidence)) {
    if (value < MIN_CONFIDENCE) {
      problems.push({ rule: "fieldConfidence", message: `Low confidence for field ${field} (${value})` });
    }
  }
  return problems;
}
