import { parseUsdc } from "@bursar/money";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { committedOf, gatewayDrawnDelta, gatewayFloatFree, jobs } from "@bursar/db";
import { requestSpend, transition } from "../src/services/spend.js";
import { db, seedJob, spend } from "./support.js";

async function loadJob(id: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  return job!;
}

/** What the float manager records once a float has left the vault for the job's Gateway balance. */
async function fundFloat(jobId: string, amount: string) {
  await db
    .update(jobs)
    .set({ gatewayFunded: sql`${jobs.gatewayFunded} + ${parseUsdc(amount).toString()}::bigint` })
    .where(eq(jobs.id, jobId));
}

const nano = (amount: string, operationId: string) => ({
  ...spend(amount, operationId),
  rail: "GATEWAY" as const,
});

describe("Gateway accounting helpers", () => {
  it("draws on the float from approval-pending through settlement, and gives it back on release", () => {
    expect(gatewayDrawnDelta("GATEWAY", "PENDING_APPROVAL", "RESERVED", 5n)).toBe(0n);
    expect(gatewayDrawnDelta("GATEWAY", "RESERVED", "SIGNING", 5n)).toBe(0n);
    expect(gatewayDrawnDelta("GATEWAY", "SIGNING", "UNRESOLVED", 5n)).toBe(0n);
    expect(gatewayDrawnDelta("GATEWAY", "SIGNING", "SETTLED", 5n)).toBe(0n);
    expect(gatewayDrawnDelta("GATEWAY", "RESERVED", "RELEASED", 5n)).toBe(-5n);
    expect(gatewayDrawnDelta("GATEWAY", "UNRESOLVED", "RELEASED", 5n)).toBe(-5n);
    expect(gatewayDrawnDelta("GATEWAY", "PENDING_APPROVAL", "REJECTED", 5n)).toBe(-5n);
  });

  it("never touches the float for vault payments", () => {
    expect(gatewayDrawnDelta("VAULT", "RESERVED", "RELEASED", 5n)).toBe(0n);
    expect(gatewayDrawnDelta("VAULT", "SIGNING", "SETTLED", 5n)).toBe(0n);
  });

  it("counts unspent float as committed, and never counts an overdrawn float twice", () => {
    const base = { settled: 10n, reserved: 5n, pending: 0n, unresolved: 0n };
    expect(committedOf({ ...base, gatewayFunded: 100n, gatewayDrawn: 30n })).toBe(85n);
    expect(committedOf({ ...base, gatewayFunded: 0n, gatewayDrawn: 5n })).toBe(15n);
    expect(gatewayFloatFree({ gatewayFunded: 100n, gatewayDrawn: 30n })).toBe(70n);
    expect(gatewayFloatFree({ gatewayFunded: 0n, gatewayDrawn: 5n })).toBe(0n);
  });
});

describe("Gateway spend decisions", () => {
  it("reserves a nano payment on the Gateway rail and marks the float as drawn", async () => {
    const { job, agents } = await seedJob();
    const result = await requestSpend(db, agents[0]!.principal, nano("0.001", "op-nano-rail-1"));
    expect(result.decision.result).toBe("ALLOWED");
    expect(result.authorization?.rail).toBe("GATEWAY");
    expect(result.authorization?.state).toBe("RESERVED");
    const after = await loadJob(job.id);
    expect(after.reserved).toBe(parseUsdc("0.001"));
    expect(after.gatewayDrawn).toBe(parseUsdc("0.001"));
    // No float yet: the payment waits for one, and counts once.
    expect(committedOf(after)).toBe(parseUsdc("0.001"));
  });

  it("pays from a funded float without charging the budget twice", async () => {
    const { job, agents } = await seedJob();
    await fundFloat(job.id, "0.10");
    expect(committedOf(await loadJob(job.id))).toBe(parseUsdc("0.10"));

    for (let i = 0; i < 3; i += 1) {
      const result = await requestSpend(
        db,
        agents[0]!.principal,
        nano("0.001", `op-nano-cov-${i}`),
      );
      expect(result.decision.result).toBe("ALLOWED");
    }
    const after = await loadJob(job.id);
    expect(after.reserved).toBe(parseUsdc("0.003"));
    expect(after.gatewayDrawn).toBe(parseUsdc("0.003"));
    expect(committedOf(after)).toBe(parseUsdc("0.10"));
  });

  it("lets a float-covered payment through when the budget is otherwise fully committed", async () => {
    const { job, agents } = await seedJob({ budget: "0.10" });
    await fundFloat(job.id, "0.10");
    const vault = await requestSpend(db, agents[0]!.principal, spend("0.01", "op-nano-full-v"));
    expect(vault.decision.result).toBe("DENIED");
    expect(vault.decision.reason).toBe("JOB_BUDGET_EXCEEDED");
    const covered = await requestSpend(db, agents[0]!.principal, nano("0.01", "op-nano-full-g"));
    expect(covered.decision.result).toBe("ALLOWED");
    expect(covered.decision.remainingAtDecision).toBe(0n);
  });

  it("denies the part of a nano payment the float can't cover once the budget runs out", async () => {
    const { job, agents } = await seedJob({ budget: "0.10" });
    await fundFloat(job.id, "0.05");
    await requestSpend(db, agents[0]!.principal, spend("0.05", "op-nano-over-v"));
    const over = await requestSpend(db, agents[0]!.principal, nano("0.06", "op-nano-over-g"));
    expect(over.decision.result).toBe("DENIED");
    expect(over.decision.reason).toBe("JOB_BUDGET_EXCEEDED");
    expect((await loadJob(job.id)).gatewayDrawn).toBe(0n);
  });

  it("returns the draw to the float when a nano payment is released", async () => {
    const { job, agents } = await seedJob();
    await fundFloat(job.id, "0.10");
    const { authorization } = await requestSpend(
      db,
      agents[0]!.principal,
      nano("0.002", "op-nano-release-1"),
    );
    await transition(db, authorization!.id, "RELEASED");
    const after = await loadJob(job.id);
    expect(after.reserved).toBe(0n);
    expect(after.gatewayDrawn).toBe(0n);
    expect(committedOf(after)).toBe(parseUsdc("0.10"));
  });

  it("settles a nano payment straight from RESERVED through SIGNING", async () => {
    const { job, agents } = await seedJob();
    await fundFloat(job.id, "0.10");
    const { authorization } = await requestSpend(
      db,
      agents[0]!.principal,
      nano("0.001", "op-nano-settle-1"),
    );
    await transition(db, authorization!.id, "SIGNING");
    await transition(db, authorization!.id, "SETTLED");
    const after = await loadJob(job.id);
    expect(after.settled).toBe(parseUsdc("0.001"));
    expect(after.gatewayDrawn).toBe(parseUsdc("0.001"));
    expect(committedOf(after)).toBe(parseUsdc("0.10"));
  });

  it("lets Postgres refuse a float that would push the job over its budget", async () => {
    const { job, agents } = await seedJob({ budget: "0.10" });
    await requestSpend(db, agents[0]!.principal, spend("0.05", "op-nano-check-1"));
    await expect(fundFloat(job.id, "0.06")).rejects.toThrow();
    await fundFloat(job.id, "0.05");
    expect(committedOf(await loadJob(job.id))).toBe(parseUsdc("0.10"));
  });
});
