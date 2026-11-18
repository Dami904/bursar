import { parseUsdc } from "@bursar/money";
import { describe, expect, it } from "vitest";
import {
  approvalConfirmations,
  approvalsPossible,
  confirmationsOf,
  MAX_SETUP_CONFIRMATIONS,
  planBatchSetup,
  planSetup,
} from "./setup.js";

const plan = (budget: string, allowance: bigint | undefined) =>
  planSetup({ budget, amount: parseUsdc(budget), allowance });

describe("job setup confirmations", () => {
  it("is open, allow, deposit: three, whatever the budget", () => {
    for (const budget of ["0.10", "1.00", "250.00"]) {
      const steps = plan(budget, 0n);
      expect(steps.filter((s) => s.signs).map((s) => s.id)).toEqual(["vault", "approve", "fund"]);
      expect(confirmationsOf(steps)).toBeLessThanOrEqual(MAX_SETUP_CONFIRMATIONS);
    }
  });

  it("is two when the wallet already allows this exact deposit or more", () => {
    expect(confirmationsOf(plan("5.00", parseUsdc("5.00")))).toBe(2);
    expect(confirmationsOf(plan("5.00", parseUsdc("50.00")))).toBe(2);
    expect(plan("5.00", parseUsdc("5.00")).some((s) => s.id === "approve")).toBe(false);
  });

  it("still asks to allow when the existing allowance is short by even a micro-USDC", () => {
    expect(confirmationsOf(plan("5.00", parseUsdc("5.00") - 1n))).toBe(3);
  });

  it("shows the allow step while the allowance is unknown, so the count is never too low", () => {
    expect(confirmationsOf(plan("5.00", undefined))).toBe(3);
  });

  it("only ever allows the exact amount, in words the owner can read", () => {
    const approve = plan("5.00", 0n).find((s) => s.id === "approve");
    expect(approve?.why).toContain("exactly 5.00 USDC");
    expect(approve?.why).toContain("once");
  });

  it("never plans the approver registration or vendor allowances at setup", () => {
    const ids = plan("5.00", 0n).map((s) => s.id);
    expect(ids).not.toContain("approver" as never);
    expect(ids.every((id) => ["create", "vault", "approve", "fund", "live"].includes(id))).toBe(
      true,
    );
  });
});

describe("bundled setup (experiment)", () => {
  it("asks for a single confirmation, and still names the exact deposit", () => {
    const steps = planBatchSetup({ budget: "5.00" });
    expect(confirmationsOf(steps)).toBe(1);
    expect(steps.find((s) => s.signs)?.label).toContain("5.00 USDC");
    expect(steps.map((s) => s.id)).toEqual(["create", "batch", "live"]);
  });
});

describe("approvals", () => {
  it("are possible only when the threshold is below the per-payment cap", () => {
    expect(approvalsPossible({ approvalThreshold: "0.10", perTxCap: "1.00" })).toBe(true);
    expect(approvalsPossible({ approvalThreshold: "1.00", perTxCap: "1.00" })).toBe(false);
    expect(approvalsPossible({ approvalThreshold: "5.00", perTxCap: "1.00" })).toBe(false);
  });

  it("take one confirmation, or two the first time on a job", () => {
    expect(approvalConfirmations(true)).toEqual(["Approve this payment"]);
    expect(approvalConfirmations(false)).toHaveLength(2);
    expect(approvalConfirmations(false).length).toBeLessThanOrEqual(MAX_SETUP_CONFIRMATIONS);
  });
});
