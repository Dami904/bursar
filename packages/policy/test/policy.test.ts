import { describe, expect, it } from "vitest";
import { currentWindow, denialReasons, evaluatePolicy } from "../src/index.js";
import { inputFor, vectors } from "../scripts/vectors.js";

describe("policy vectors", () => {
  it.each(vectors.map((c) => [c.name, c] as const))("%s", (_name, vector) => {
    const result = evaluatePolicy(inputFor(vector));
    expect(result.outcome).toBe(vector.expect.outcome);
    if (vector.expect.reason !== undefined) {
      expect(result.outcome === "DENIED" && result.reason).toBe(vector.expect.reason);
    }
  });

  it("covers every denial reason at least once", () => {
    const covered = new Set(vectors.map((c) => c.expect.reason).filter(Boolean));
    for (const reason of denialReasons) {
      expect(covered, `no vector for ${reason}`).toContain(reason);
    }
  });
});

describe("check trace", () => {
  it("lists every check up to and including the first failure", () => {
    const base = inputFor({ override: {} });
    const result = evaluatePolicy({ ...base, payee: null });
    expect(result.checks.map((c) => c.check)).toEqual(denialReasons.slice(0, 6));
    expect(result.checks.at(-1)).toEqual({ check: "PAYEE_NOT_ALLOWED", passed: false });
  });

  it("lists every check when allowed", () => {
    const base = inputFor({ override: {} });
    const result = evaluatePolicy(base);
    expect(result.checks).toHaveLength(denialReasons.length);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });
});

describe("currentWindow", () => {
  const job = {
    windowSeconds: 3600,
    windowStart: new Date("2026-09-28T09:00:00Z"),
    windowSpent: 500n,
  };

  it("keeps the window open before it ends", () => {
    expect(currentWindow(job, new Date("2026-09-28T09:59:59Z"))).toEqual({
      start: job.windowStart,
      spent: 500n,
    });
  });

  it("starts a fresh window at the exact end", () => {
    const now = new Date("2026-09-28T10:00:00Z");
    expect(currentWindow(job, now)).toEqual({ start: now, spent: 0n });
  });
});
