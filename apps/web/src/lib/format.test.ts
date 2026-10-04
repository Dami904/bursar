import { describe, expect, it } from "vitest";
import { blockedBecause, ruleLines, statusOf, verdictOf } from "./format.js";

describe("rule wording", () => {
  it("has a pass and a stop line for every rule the API can name", () => {
    for (const rule of Object.keys(blockedBecause)) {
      const line = ruleLines[rule];
      expect(line?.pass.length ?? 0, rule).toBeGreaterThan(0);
      expect(line?.fail.length ?? 0, rule).toBeGreaterThan(0);
    }
    expect(Object.keys(ruleLines)).toHaveLength(12);
  });
});

describe("a voucher's verdict", () => {
  it("stamps each outcome in the console's own words", () => {
    expect(verdictOf({ result: "DENIED", state: null })).toMatchObject({ stamp: "BLOCKED" });
    expect(verdictOf({ result: "ALLOWED", state: "SETTLED" })).toMatchObject({
      stamp: "PAID",
      tone: "paid",
    });
    expect(verdictOf({ result: "NEEDS_APPROVAL", state: "PENDING_APPROVAL" })).toMatchObject({
      stamp: "NEEDS YOU",
    });
    expect(verdictOf({ result: "ALLOWED", state: "UNRESOLVED" })).toMatchObject({ stamp: "STUCK" });
    expect(verdictOf({ result: "ALLOWED", state: "RELEASED" })).toMatchObject({
      stamp: "RETURNED",
    });
    expect(verdictOf({ result: "ALLOWED", state: "SIGNING" })).toMatchObject({ stamp: "HELD" });
  });

  it("agrees with the status word shown in lists", () => {
    for (const state of ["SETTLED", "UNRESOLVED", "PENDING_APPROVAL", "RESERVED"] as const) {
      const d = { result: "ALLOWED" as const, state };
      expect(verdictOf(d).tone).toBe(statusOf(d).tone);
    }
  });
});
