import {
  agents,
  createDb,
  credentials,
  decisions,
  hashKey,
  jobs,
  operatorRuns,
  type Db,
} from "@bursar/db";
import { parseUsdc } from "@bursar/money";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createJob, recordFunding, recordJobCreatedOnChain } from "../../api/src/services/jobs.js";
import { createOwner } from "../../api/src/services/owners.js";
import { testDatabaseUrl } from "../../api/test/global-setup.js";
import { autopilotOnce, type AutopilotDeps, type RunRequest } from "../src/autopilot.js";

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

async function liveJob(brief: string | null = "Buy one insight line for the newsletter.") {
  const { owner } = await createOwner(db, "Studio");
  const job = await createJob(db, owner.id, {
    title: "Newsletter",
    customer: "Acme",
    budget: parseUsdc("1.00"),
    perTxCap: parseUsdc("1.00"),
    approvalThreshold: parseUsdc("1.00"),
    windowCap: parseUsdc("1.00"),
    windowSeconds: 3600,
    expiresAt: new Date(Date.now() + 86_400_000),
    delegationAllowed: true,
    brief: brief ?? undefined,
  });
  await recordJobCreatedOnChain(db, job.id, `vault-${job.id}`);
  await recordFunding(db, job.id, parseUsdc("1.00"));
  return job;
}

/** A stand-in operator: records each request and finishes when told to. */
function fakeRuns() {
  const requests: RunRequest[] = [];
  let finish: (outcome?: string, steps?: number) => void = () => undefined;
  const deps: AutopilotDeps = {
    db: undefined as unknown as Db,
    running: new Set(),
    run: (request) => {
      requests.push(request);
      return new Promise((resolve) => {
        finish = (outcome = "completed", steps = 3) =>
          resolve({ outcome, summary: "done", costMicros: 1000, steps });
      });
    },
  };
  return {
    requests,
    deps,
    finish: (outcome?: string, steps?: number) => finish(outcome, steps),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function keyWorks(key: string) {
  const [row] = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.keyHash, hashKey(key)), isNull(credentials.revokedAt)));
  return row !== undefined;
}

describe("autopilot", () => {
  it("starts the operator once when a job with a brief goes live, with a key that dies with the run", async () => {
    const job = await liveJob();
    const fake = fakeRuns();
    const deps = { ...fake.deps, db };

    expect(await autopilotOnce(deps)).toBe(job.id);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.brief).toBe("Buy one insight line for the newsletter.");
    const key = fake.requests[0]!.key;
    expect(await keyWorks(key)).toBe(true);
    const [agent] = await db.select().from(agents).where(eq(agents.jobId, job.id));
    expect(agent).toMatchObject({ name: "Operator (auto)", status: "ACTIVE" });

    // One at a time, and never twice for the same event.
    expect(await autopilotOnce(deps)).toBeNull();
    fake.finish();
    await settle();
    expect(await keyWorks(key)).toBe(false);
    expect(deps.running.size).toBe(0);
    expect(await autopilotOnce(deps)).toBeNull();
  });

  it("runs again when new revenue arrives, and says how much", async () => {
    const job = await liveJob();
    const fake = fakeRuns();
    const deps = { ...fake.deps, db };
    await autopilotOnce(deps);
    fake.finish();
    await settle();

    await db
      .update(jobs)
      .set({ revenueReceived: parseUsdc("0.25") })
      .where(eq(jobs.id, job.id));
    expect(await autopilotOnce(deps)).toBe(job.id);
    expect(fake.requests[1]!.brief).toContain("a customer just paid 0.25 USDC");
    // The same agent, with a new key.
    expect(await db.select().from(agents).where(eq(agents.jobId, job.id))).toHaveLength(1);
    expect(fake.requests[1]!.key).not.toBe(fake.requests[0]!.key);
  });

  it("leaves jobs without a brief, frozen jobs, and jobs whose auto agent was revoked alone", async () => {
    await liveJob(null);
    const frozen = await liveJob();
    await db.update(jobs).set({ frozenReason: "unexplained payout" }).where(eq(jobs.id, frozen.id));
    const fake = fakeRuns();
    expect(await autopilotOnce({ ...fake.deps, db })).toBeNull();

    const revoked = await liveJob();
    const deps = { ...fake.deps, db };
    await autopilotOnce(deps);
    fake.finish();
    await settle();
    await db.update(agents).set({ status: "REVOKED" }).where(eq(agents.jobId, revoked.id));
    await db
      .update(jobs)
      .set({ revenueReceived: parseUsdc("0.10") })
      .where(eq(jobs.id, revoked.id));
    expect(await autopilotOnce(deps)).toBeNull();
    expect(fake.requests).toHaveLength(1);
  });

  it("retries a run that never got going (model unavailable), after a pause", async () => {
    const job = await liveJob();
    const fake = fakeRuns();
    const retries = new Map<string, { attempts: number; after: number }>();
    const deps = { ...fake.deps, db, retries };
    await autopilotOnce(deps);
    fake.finish("error", 0);
    await settle();
    expect(retries.get(job.id)?.attempts).toBe(1);
    // Due again, but cooling down.
    expect(await autopilotOnce(deps)).toBeNull();
    retries.set(job.id, { attempts: 1, after: Date.now() - 1 });
    expect(await autopilotOnce(deps)).toBe(job.id);
    fake.finish();
    await settle();
    expect(retries.has(job.id)).toBe(false);
  });

  it("tells each run what earlier runs already bought, so it doesn't repeat itself", async () => {
    const job = await liveJob();
    const [agent] = await db
      .insert(agents)
      .values({ jobId: job.id, name: "Operator", role: "operator" })
      .returning();
    await db.insert(decisions).values({
      jobId: job.id,
      agentId: agent!.id,
      operationId: "op-history-01",
      kind: "PURCHASE",
      payee: "https://seller.example",
      amount: 20_000n,
      reasoning: "script line",
      result: "ALLOWED",
      checks: [],
      remainingAtDecision: 980_000n,
    });
    const fake = fakeRuns();
    await autopilotOnce({ ...fake.deps, db });
    expect(fake.requests[0]!.brief).toContain("What earlier runs on this job already did");
    expect(fake.requests[0]!.brief).toContain("https://seller.example, 0.02 USDC");
    fake.finish();
    await settle();
  });

  /** A job with one earlier purchase and one earlier run of `ranBrief`, ready for another run. */
  async function jobWithHistory(ranBrief: string) {
    const job = await liveJob();
    const [agent] = await db
      .insert(agents)
      .values({ jobId: job.id, name: "Operator", role: "operator" })
      .returning();
    await db.insert(decisions).values({
      jobId: job.id,
      agentId: agent!.id,
      operationId: `op-repeat-${job.id.slice(0, 8)}`,
      kind: "PURCHASE",
      payee: "https://seller.example",
      amount: 150_000n,
      reasoning: "market report",
      result: "ALLOWED",
      checks: [],
      remainingAtDecision: 850_000n,
    });
    await db.insert(operatorRuns).values({
      jobId: job.id,
      agentId: agent!.id,
      model: "test",
      brief: `${ranBrief}\n\nWhat earlier runs on this job already did. (an older note)`,
      steps: 3,
      inputTokens: 1,
      outputTokens: 1,
      costMicros: 1n,
      outcome: "completed",
      summary: "bought it",
    });
    return job;
  }

  it("tells a repeat of the same brief not to buy again what an earlier run delivered", async () => {
    const job = await jobWithHistory("Buy one insight line for the newsletter.");
    const fake = fakeRuns();
    await autopilotOnce({ ...fake.deps, db });
    const brief = fake.requests[0]!.brief;
    expect(brief).toContain("hasn't changed since the last run");
    expect(brief).toContain("don't buy it again");
    expect(job.id).toBe(fake.requests[0]!.jobId);
    fake.finish();
    await settle();
  });

  it("treats a new brief as a new request, so a scene that buys the same thing again does", async () => {
    await jobWithHistory("Some earlier brief that is not the current one.");
    const fake = fakeRuns();
    await autopilotOnce({ ...fake.deps, db });
    const brief = fake.requests[0]!.brief;
    expect(brief).toContain("new request");
    expect(brief).toContain("even if an earlier run bought something similar");
    expect(brief).not.toContain("don't buy it again");
    fake.finish();
    await settle();
  });
});
