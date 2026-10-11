import { describe, expect, it } from "vitest";
import {
  checkConfidence,
  checkInvoice,
  currencyIsKnown,
  dateIsPresent,
  dateNotInFuture,
  totalIsPositive,
  totalMatchesLineItems,
} from "../src/rules.js";
import type { Invoice } from "../src/schema.js";

// A good invoice: lines 480 + 650 + 95.50 = 1225.50. Each test breaks one field.
const goodInvoice: Invoice = {
  invoiceNumber: "INV-1",
  date: "2026-09-15",
  vendor: "Nordic Office Supplies GmbH",
  currency: "EUR",
  total: 1225.5,
  lineItems: [
    { description: "Chair", amount: 480 },
    { description: "Desk", amount: 650 },
    { description: "Arm", amount: 95.5 },
  ],
};

describe("totalMatchesLineItems", () => {
  it("total matches: no problem", () => {
    expect(totalMatchesLineItems(goodInvoice)).toBeNull();
  });

  it("a 1-cent difference is within the 0.01 tolerance", () => {
    expect(totalMatchesLineItems({ ...goodInvoice, total: 1225.51 })).toBeNull();
    expect(totalMatchesLineItems({ ...goodInvoice, total: 1225.49 })).toBeNull();
  });

  it("a 2-cent difference is already a problem", () => {
    expect(totalMatchesLineItems({ ...goodInvoice, total: 1225.52 })).toBe(
      "Line items sum to 1225.5, but total is 1225.52 (difference: 0.02)",
    );
  });

  it("total does not match: the text contains the signed difference", () => {
    expect(totalMatchesLineItems({ ...goodInvoice, total: 1325.5 })).toContain("(difference: 100)");
    expect(totalMatchesLineItems({ ...goodInvoice, total: 1200 })).toContain("(difference: -25.5)");
  });
});

describe("dates", () => {
  it("no date: problem", () => {
    expect(dateIsPresent({ ...goodInvoice, date: null })).toBe("Invoice date is missing");
  });

  it("no date: the future-date rule stays silent to avoid duplication", () => {
    expect(dateNotInFuture({ ...goodInvoice, date: null })).toBeNull();
  });

  it("date in the future: problem", () => {
    expect(dateNotInFuture({ ...goodInvoice, date: "2999-01-01" })).toBe("Date 2999-01-01 is in the future");
  });

  it("date not in YYYY-MM-DD format: problem", () => {
    expect(dateNotInFuture({ ...goodInvoice, date: "12 March 2026" })).toContain("not in YYYY-MM-DD format");
  });
});

describe("currency and total", () => {
  it("unknown currency: problem", () => {
    expect(currencyIsKnown({ ...goodInvoice, currency: "GBP" })).toContain('Unknown currency "GBP"');
  });

  it("no currency: problem", () => {
    expect(currencyIsKnown({ ...goodInvoice, currency: null })).toBe("Currency is missing");
  });

  it("negative total: problem", () => {
    expect(totalIsPositive({ ...goodInvoice, total: -5 })).toBe("Total must be positive, but it is -5");
  });
});

describe("confidence", () => {
  const confident = { invoiceNumber: 1, date: 1, vendor: 1, currency: 1, total: 1, lineItems: 1 };

  it("0.79 below the 0.8 threshold: problem", () => {
    expect(checkConfidence({ ...confident, total: 0.79 })).toEqual([
      { rule: "fieldConfidence", message: "Low confidence for field total (0.79)" },
    ]);
  });

  it("0.8 exactly at the threshold: no problem", () => {
    expect(checkConfidence({ ...confident, total: 0.8 })).toEqual([]);
  });
});

describe("checkInvoice as a whole", () => {
  it("good invoice: ok with no problems", () => {
    expect(checkInvoice(goodInvoice)).toEqual({ status: "ok", problems: [] });
  });

  it("several errors at once: needs_review and all problems with rule names", () => {
    const result = checkInvoice({ ...goodInvoice, date: null, currency: "GBP" });
    expect(result.status).toBe("needs_review");
    expect(result.problems.map((p) => p.rule)).toEqual(["dateIsPresent", "currencyIsKnown"]);
  });
});
