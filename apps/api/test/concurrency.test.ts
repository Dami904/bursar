import { parseUsdc } from "@bursar/money";
import { bucketOf, type AuthorizationState } from "@bursar/policy";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authorizations, decisions, jobs } from "@bursar/db";
import { requestSpend, transition } from "../src/services/spend.js";
import { db, seedJob, spend } from "./support.js";

/** Small deterministic PRNG so failures reproduce from the seed. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function loadJob(id: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (job === undefined) throw new Error("job missing");
  return job;
}

/** Job counters must equal the sum of its authorizations, bucket by bucket. */
async function expectCountersMatchAuthorizations(jobId: string) {
  const job = await loadJob(jobId);
  const rows = await db.select().from(authorizations).where(eq(authorizations.jobId, jobId));
  const sums = { pending: 0n, reserved: 0n, unresolved: 0n, settled: 0n };
  for (const row of rows) {
    const bucket = bucketOf[row.state];
    if (bucket !== null) sums[bucket] += row.amount;
  }
  expect({
    pending: job.pending,
    reserved: job.reserved,
    unresolved: job.unresolved,
    settled: job.settled,
  }).toEqual(sums);
  expect(job.settled + job.reserved + job.pending + job.unresolved).toBeLessThanOrEqual(job.budget);
}

describe("parallel agents never overspend a shared job budget", () => {
  it("25 parallel 0.10 requests against 1.00 approve exactly 10", async () => {
    const { job, agents } = await seedJob({ budget: "1.00", agents: 5 });
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        requestSpend(db, agents[i % 5]!.principal, spend("0.10", `op-parallel-${i}`)),
      ),
    );

    const allowed = results.filter((r) => r.decision.result === "ALLOWED");
    const denied = results.filter((r) => r.decision.result === "DENIED");
    expect(allowed).toHaveLength(10);
    expect(denied).toHaveLength(15);
    expect(new Set(denied.map((r) => r.decision.reason))).toEqual(new Set(["JOB_BUDGET_EXCEEDED"]));

    const after = await loadJob(job.id);
    expect(after.reserved).toBe(parseUsdc("1.00"));
    expect(await db.$count(decisions, eq(decisions.jobId, job.id))).toBe(25);
    await expectCountersMatchAuthorizations(job.id);
  });

  it("40 parallel requests of mixed sizes stay within the budget", async () => {
    const random = mulberry32(42);
    const { job, agents } = await seedJob({ budget: "2.00", agents: 4 });
    const amounts = Array.from({ length: 40 }, () => BigInt(1 + Math.floor(random() * 300_000)));
    const results = await Promise.all(
      amounts.map((amount, i) =>
        requestSpend(db, agents[i % 4]!.principal, {
          ...spend("0.01", `op-mixed-${i}`),
          amount,
        }),
      ),
    );

    const allowedTotal = results
      .filter((r) => r.decision.result === "ALLOWED")
      .reduce((sum, r) => sum + r.decision.amount, 0n);
    const after = await loadJob(job.id);
    expect(after.reserved).toBe(allowedTotal);
    expect(allowedTotal).toBeLessThanOrEqual(parseUsdc("2.00"));
    // Every denial is a real lack of room at the moment it was decided.
    for (const r of results.filter((r) => r.decision.result === "DENIED")) {
      expect(r.decision.reason).toBe("JOB_BUDGET_EXCEEDED");
      expect(r.decision.amount).toBeGreaterThan(r.decision.remainingAtDecision);
    }
    await expectCountersMatchAuthorizations(job.id);
  });
});

describe("one operation ID, one decision", () => {
  it("20 concurrent retries of the same operation create exactly one authorization", async () => {
    const { job, agents } = await seedJob({ budget: "1.00" });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        requestSpend(db, agents[0]!.principal, spend("0.40", "op-retry-1")),
      ),
    );

    expect(new Set(results.map((r) => r.decision.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await db.$count(decisions, eq(decisions.jobId, job.id))).toBe(1);
    expect(await db.$count(authorizations, eq(authorizations.jobId, job.id))).toBe(1);
    expect((await loadJob(job.id)).reserved).toBe(parseUsdc("0.40"));
  });
});

describe("randomised interleavings keep counters exact", () => {
  const nextStates: Partial<Record<AuthorizationState, readonly AuthorizationState[]>> = {
    RESERVED: ["RELEASING", "RELEASED"],
    RELEASING: ["FUNDED_WALLET", "UNRESOLVED", "RELEASED", "SETTLED"],
    FUNDED_WALLET: ["SIGNING", "RELEASED"],
    SIGNING: ["SETTLED", "UNRESOLVED", "RELEASED"],
    UNRESOLVED: ["SETTLED", "RELEASED"],
  };

  for (const seed of [1, 7, 2026]) {
    it(`seed ${seed}: spends and state changes in parallel, invariant after every round`, async () => {
      const random = mulberry32(seed);
      const { job, agents } = await seedJob({ budget: "1.50", agents: 3 });
      let op = 0;
      for (let round = 0; round < 8; round += 1) {
        const open = await db.select().from(authorizations).where(eq(authorizations.jobId, job.id));
        const work: Promise<unknown>[] = [];
        for (let i = 0; i < 6; i += 1) {
          const agent = agents[Math.floor(random() * agents.length)]!;
          const amount = BigInt(10_000 + Math.floor(random() * 250_000));
          work.push(
            requestSpend(db, agent.principal, { ...spend("0.01", `op-${seed}-${op++}`), amount }),
          );
        }
        for (const auth of open) {
          const options = nextStates[auth.state];
          if (options === undefined || random() < 0.4) continue;
          const to = options[Math.floor(random() * options.length)]!;
          // Two racers may try to move the same authorization; one gets ILLEGAL_TRANSITION.
          work.push(transition(db, auth.id, to).catch(() => undefined));
        }
        await Promise.all(work);
        await expectCountersMatchAuthorizations(job.id);
      }
    });
  }
});

describe("Postgres backstop", () => {
  it("rejects any write that would break the budget rule, even outside the service", async () => {
    const { job } = await seedJob({ budget: "1.00" });
    const error = await db
      .execute(sql`UPDATE jobs SET reserved = budget + 1 WHERE id = ${job.id}`)
      .then(
        () => null,
        (e: unknown) => e,
      );
    // Drizzle wraps the Postgres error; the violated constraint is on its cause.
    expect((error as { cause?: { constraint_name?: string } }).cause?.constraint_name).toBe(
      "jobs_budget_invariant",
    );
  });
});
