import {
  DEFAULT_DEMO_PLAN,
  DEMO_SCENES,
  agents,
  chainCursors,
  createDb,
  decideDemoRun,
  demoRunState,
  jobs,
  operatorRuns,
  requestDemoRun,
  serveDemoRequest,
  type Db,
  type DemoRunInput,
} from "@bursar/db";
import { parseUsdc } from "@bursar/money";
import { eq, sql } from "drizzle-orm";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgent } from "../../api/src/services/agents.js";
import {
  addPayee,
  createJob,
  recordFunding,
  recordJobCreatedOnChain,
} from "../../api/src/services/jobs.js";
import { createOwner } from "../../api/src/services/owners.js";
import { requestSpend } from "../../api/src/services/spend.js";
import { testDatabaseUrl } from "../../api/test/global-setup.js";
import {
  DEMO_BRIEFS,
  approveDemoPayments,
  demoApprovalWaiting,
  rotateDemoBrief,
  serveDemoClick,
  type DemoDeps,
} from "../src/demo.js";

let db: Db;
let end: () => Promise<void>;
beforeAll(() => {
  const created = createDb(testDatabaseUrl(), { max: 5 });
  db = created.db;
  end = () => created.client.end();
});
afterAll(async () => end());
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE owners, jobs, agents, credentials, payees, category_limits, decisions, authorizations, chain_events, chain_cursors, approvers, approvals, operator_runs, metrics_daily, audit_chain, audit_anchors, siwe_nonces, alert_targets, alerts, telegram_links RESTART IDENTITY CASCADE`,
  );
});

async function demoJob() {
  const { owner } = await createOwner(db, "Bursar Films");
  const job = await createJob(db, owner.id, {
    title: "Short film",
    customer: "Bursar Films",
    budget: parseUsdc("2.00"),
    perTxCap: parseUsdc("0.50"),
    approvalThreshold: parseUsdc("0.10"),
    windowCap: parseUsdc("2.00"),
    windowSeconds: 3600,
    expiresAt: new Date(Date.now() + 86_400_000),
    delegationAllowed: true,
    brief: DEMO_BRIEFS[0],
  });
  await recordJobCreatedOnChain(db, job.id, `vault-${job.id}`);
  await recordFunding(db, job.id, parseUsdc("2.00"));
  return job;
}

const deps = (jobId: string, overrides: Partial<DemoDeps> = {}): DemoDeps => ({
  db,
  jobId,
  intervalMs: 3_600_000,
  running: new Set(),
  ...overrides,
});

describe("demo brief rotation", () => {
  it("moves to the next brief once the last run is old enough, in order", async () => {
    const job = await demoJob();
    // Not run yet: nothing to rotate.
    expect(await rotateDemoBrief(deps(job.id))).toBeNull();
    await db.update(jobs).set({ operatorRunAt: new Date() }).where(eq(jobs.id, job.id));
    expect(await rotateDemoBrief(deps(job.id))).toBeNull(); // too recent
    await db
      .update(jobs)
      .set({ operatorRunAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(eq(jobs.id, job.id));
    expect(await rotateDemoBrief(deps(job.id))).toBe(DEMO_BRIEFS[0]);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row).toMatchObject({ operatorRunAt: null });

    await db
      .update(jobs)
      .set({ operatorRunAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(eq(jobs.id, job.id));
    expect(await rotateDemoBrief(deps(job.id))).toBe(DEMO_BRIEFS[1]);
    const [cursor] = await db
      .select()
      .from(chainCursors)
      .where(eq(chainCursors.name, "demo-brief"));
    expect(cursor?.block).toBe(1);
  });

  it("waits while a run is in progress", async () => {
    const job = await demoJob();
    await db
      .update(jobs)
      .set({ operatorRunAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(eq(jobs.id, job.id));
    expect(await rotateDemoBrief(deps(job.id, { running: new Set([job.id]) }))).toBeNull();
  });
});

describe("demo approver", () => {
  it("signs the demo job's payments after they've waited, and leaves other jobs alone", async () => {
    const typedData = {
      domain: {
        name: "Bursar JobVault",
        version: "1",
        chainId: 5042002,
        verifyingContract: "0x5Cd51a31fE931D31574Eadd083A0B5c210CA2cB6",
      },
      types: {
        Approval: [
          { name: "amount", type: "uint128" },
          { name: "deadline", type: "uint64" },
          { name: "policyVersion", type: "uint64" },
        ],
      },
      primaryType: "Approval",
      message: { amount: "150000", deadline: "1790000000", policyVersion: "2" },
    };
    const old = new Date(Date.now() - 120_000).toISOString();
    const fresh = new Date().toISOString();
    const posted: { url: string; body: Record<string, unknown> }[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push({
          url: String(url),
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
        return new Response("{}", { status: 200 });
      }
      return new Response(
        JSON.stringify({
          pending: [
            { authorizationId: "a-demo-old", jobId: "demo", requestedAt: old, typedData },
            { authorizationId: "a-demo-new", jobId: "demo", requestedAt: fresh, typedData },
            { authorizationId: "a-other", jobId: "other", requestedAt: old, typedData },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const approved = await approveDemoPayments(
      deps("demo", {
        approver: {
          apiUrl: "http://api.test",
          key: "bsr_apr_x",
          privateKey: generatePrivateKey(),
          afterMs: 60_000,
        },
      }),
      fetchFn,
    );
    expect(approved).toBe(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe("http://api.test/approvals/a-demo-old");
    expect(posted[0]!.body).toMatchObject({
      verdict: "APPROVE",
      deadline: 1790000000,
      policyVersion: 2,
    });
  });

  it("only has work when a demo payment has waited long enough, so an idle server can sleep", async () => {
    const job = await demoJob();
    const approver = {
      apiUrl: "http://api.test",
      key: "bsr_apr_x",
      privateKey: generatePrivateKey(),
      afterMs: 60_000,
    };
    expect(await demoApprovalWaiting(deps(job.id, { approver }))).toBe(false);

    // An invoice above the job's 0.10 approval threshold waits for an approver.
    const vendor = `0x${"4".repeat(40)}`;
    await addPayee(db, job.ownerId, job.id, { kind: "ADDRESS", value: vendor });
    const { agent } = await createAgent(db, job.ownerId, job.id, { name: "Op", role: "operator" });
    const spend = await requestSpend(
      db,
      { role: "AGENT", credentialId: "t", ownerId: job.ownerId, jobId: job.id, agentId: agent.id },
      {
        operationId: "op-demo-wait-1",
        kind: "INVOICE",
        payee: { kind: "ADDRESS", value: vendor },
        amount: parseUsdc("0.25"),
        invoiceRef: "VO-12",
        reasoning: "demo test",
      },
    );
    expect(spend.authorization?.state).toBe("PENDING_APPROVAL");

    // Too fresh: still nothing to do.
    expect(await demoApprovalWaiting(deps(job.id, { approver }))).toBe(false);
    const later = new Date(Date.now() + 2 * 60_000);
    expect(await demoApprovalWaiting(deps(job.id, { approver, now: () => later }))).toBe(true);
    // Without an approver configured there's never anything to do.
    expect(await demoApprovalWaiting(deps(job.id, { now: () => later }))).toBe(false);
  });
});

const MIN = 60_000;
const NOW = new Date("2026-10-07T12:00:00Z");
const PLAN = {
  cooldownMs: 5 * MIN,
  maxPerDay: 10,
  lastsUntil: new Date("2026-11-01T00:00:00Z"),
  reserveMicros: 100_000n,
};
// Ends tomorrow, so the whole budget above the reserve is spendable today: for walking the scenes.
const SHORT_PLAN = { ...PLAN, maxPerDay: 100, lastsUntil: new Date("2026-10-08T00:00:00Z") };

function input(over: Partial<DemoRunInput> = {}): DemoRunInput {
  return {
    now: NOW,
    plan: PLAN,
    active: true,
    lastRunAt: new Date(NOW.getTime() - 10 * MIN),
    requestPending: false,
    runsLast24h: 0,
    spentLast24h: 0n,
    remaining: parseUsdc("1.53"),
    next: DEMO_SCENES[0]!,
    ...over,
  };
}

describe("when a visitor may run the next demo scene", () => {
  it("allows a scene when nothing stands in the way", () => {
    expect(decideDemoRun(input())).toMatchObject({ canRun: true, reason: null });
  });

  it("says why not, in order: closed, queued, running, too soon, too many today", () => {
    expect(decideDemoRun(input({ active: false })).reason).toBe("NOT_ACTIVE");
    expect(decideDemoRun(input({ requestPending: true })).reason).toBe("PENDING");
    expect(decideDemoRun(input({ lastRunAt: null })).reason).toBe("BUSY");
    const soon = decideDemoRun(input({ lastRunAt: new Date(NOW.getTime() - 2 * MIN) }));
    expect(soon).toMatchObject({ canRun: false, reason: "COOLDOWN", retryAfterSeconds: 180 });
    expect(decideDemoRun(input({ runsLast24h: 10 })).reason).toBe("DAILY_LIMIT");
  });

  it("spreads the budget over the days left: a dear scene waits for a bigger allowance", () => {
    // 1.53 USDC, less the 0.10 reserve, over about 24.5 days is about 0.058 a day.
    const cheap = decideDemoRun(input({ next: DEMO_SCENES[1]! }));
    expect(cheap.canRun).toBe(true);
    expect(cheap.allowancePerDay).toBeGreaterThan(56_000n);
    expect(cheap.allowancePerDay).toBeLessThan(60_000n);
    const dear = decideDemoRun(input({ next: DEMO_SCENES[2]! }));
    expect(dear).toMatchObject({ canRun: false, reason: "BUDGET_PACE" });
    // The same scene is fine once the budget is topped up.
    const toppedUp = input({ next: DEMO_SCENES[2]!, remaining: parseUsdc("6") });
    expect(decideDemoRun(toppedUp).canRun).toBe(true);
    // And today's spending counts: a cheap scene is refused once the day's share is gone.
    expect(decideDemoRun(input({ spentLast24h: parseUsdc("0.05") })).reason).toBe("BUDGET_PACE");
  });

  it("never lets a day's spending empty the job before the date it must last until", () => {
    let remaining = parseUsdc("1.53");
    const start = NOW.getTime();
    // Through the last day and past it: spend the whole allowance each day, the worst a stream
    // of clicks can do. The reserve is always still there.
    for (let day = 0; day < 27; day += 1) {
      const now = new Date(start + day * 86_400_000);
      const verdict = decideDemoRun(input({ now, remaining }));
      remaining -= verdict.allowancePerDay;
      expect(remaining).toBeGreaterThanOrEqual(PLAN.reserveMicros);
    }
  });

  it("holds back the reserve even on the last day", () => {
    const lastDay = new Date(PLAN.lastsUntil.getTime() - 3_600_000);
    const verdict = decideDemoRun(input({ now: lastDay, remaining: parseUsdc("0.30") }));
    expect(verdict.allowancePerDay).toBe(200_000n);
    expect(decideDemoRun(input({ now: lastDay, remaining: parseUsdc("0.10") })).reason).toBe(
      "BUDGET_PACE",
    );
  });
});

describe("running the demo on request", () => {
  async function idleDemoJob() {
    const job = await demoJob();
    await db
      .update(jobs)
      .set({ operatorRunAt: new Date(NOW.getTime() - 10 * MIN) })
      .where(eq(jobs.id, job.id));
    return job;
  }

  it("does nothing until someone clicks, then sets the next scene once", async () => {
    const job = await idleDemoJob();
    // No click: the worker has nothing to do, however long the job has been idle.
    expect(await serveDemoRequest(db, job.id, NOW)).toBeNull();

    const first = await requestDemoRun(db, job.id, PLAN, NOW);
    expect(first.accepted).toBe(true);
    // A second click before the worker has looked is held, not queued twice.
    const second = await requestDemoRun(db, job.id, PLAN, NOW);
    expect(second.accepted).toBe(false);
    expect(second.state?.verdict.reason).toBe("PENDING");

    expect(await serveDemoRequest(db, job.id, NOW)).toBe(DEMO_SCENES[0]!.brief);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row).toMatchObject({ brief: DEMO_SCENES[0]!.brief, operatorRunAt: null });
    // Served: nothing more happens by itself.
    expect(await serveDemoRequest(db, job.id, NOW)).toBeNull();
  });

  it("goes through the scenes in order, one click each, and wraps around", async () => {
    const job = await demoJob();
    for (let i = 0; i < DEMO_SCENES.length + 1; i += 1) {
      const now = new Date(NOW.getTime() + i * 10 * MIN);
      await db
        .update(jobs)
        .set({ operatorRunAt: new Date(now.getTime() - 6 * MIN) })
        .where(eq(jobs.id, job.id));
      const state = await demoRunState(db, job.id, SHORT_PLAN, now);
      expect(state?.nextIndex).toBe(i % DEMO_SCENES.length);
      const { accepted } = await requestDemoRun(db, job.id, SHORT_PLAN, now);
      expect(accepted).toBe(true);
      const brief = await serveDemoRequest(db, job.id, now);
      expect(brief).toBe(DEMO_SCENES[i % DEMO_SCENES.length]!.brief);
    }
  });

  it("waits while a brief is still waiting to run, and while a run is in progress", async () => {
    const job = await demoJob(); // its brief hasn't run yet
    const early = await requestDemoRun(db, job.id, PLAN, NOW);
    expect(early.state?.verdict.reason).toBe("BUSY");
    await db
      .update(jobs)
      .set({ operatorRunAt: new Date(NOW.getTime() - 10 * MIN) })
      .where(eq(jobs.id, job.id));
    expect((await requestDemoRun(db, job.id, PLAN, NOW)).accepted).toBe(true);
    // The worker doesn't switch scenes under a run in progress.
    const busy = deps(job.id, { running: new Set([job.id]) });
    expect(await serveDemoClick(busy)).toBeNull();
    expect(await serveDemoClick(deps(job.id, { now: () => NOW }))).toBe(DEMO_SCENES[0]!.brief);
  });

  it("counts only the operator's own runs toward the day's limit, not helpers'", async () => {
    const job = await idleDemoJob();
    const [operator] = await db
      .insert(agents)
      .values({ jobId: job.id, name: "Operator (auto)", role: "operator" })
      .returning();
    const [helper] = await db
      .insert(agents)
      .values({ jobId: job.id, name: "helper", role: "operator", parentAgentId: operator!.id })
      .returning();
    const run = (agentId: string) => ({
      jobId: job.id,
      agentId,
      model: "test",
      brief: "b",
      steps: 1,
      inputTokens: 1,
      outputTokens: 1,
      costMicros: 1n,
      outcome: "completed" as const,
      createdAt: new Date(NOW.getTime() - 3_600_000),
    });
    await db.insert(operatorRuns).values([run(operator!.id), run(operator!.id), run(helper!.id)]);
    expect((await demoRunState(db, job.id, PLAN, NOW))?.runsLast24h).toBe(2);
    await db.insert(operatorRuns).values(Array.from({ length: 8 }, () => run(operator!.id)));
    const full = await requestDemoRun(db, job.id, PLAN, NOW);
    expect(full.state?.verdict.reason).toBe("DAILY_LIMIT");
  });

  it("refuses a click once the budget can't be spread to last", async () => {
    const job = await idleDemoJob();
    await db
      .update(jobs)
      .set({ settled: parseUsdc("1.97") })
      .where(eq(jobs.id, job.id));
    // 0.03 USDC left over 24 days: not even the cheapest scene fits.
    const result = await requestDemoRun(db, job.id, PLAN, NOW);
    expect(result.accepted).toBe(false);
    expect(result.state?.verdict.reason).toBe("BUDGET_PACE");
    expect(await serveDemoRequest(db, job.id, NOW)).toBeNull();
  });

  it("keeps the default plan's end date at 3 November, the demo job's own expiry", () => {
    expect(DEFAULT_DEMO_PLAN.lastsUntil.toISOString()).toBe("2026-11-03T00:00:00.000Z");
  });
});
