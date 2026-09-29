import { chainCursors, createDb, jobs, type Db } from "@bursar/db";
import { parseUsdc } from "@bursar/money";
import { eq, sql } from "drizzle-orm";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createJob, recordFunding, recordJobCreatedOnChain } from "../../api/src/services/jobs.js";
import { createOwner } from "../../api/src/services/owners.js";
import { testDatabaseUrl } from "../../api/test/global-setup.js";
import { DEMO_BRIEFS, approveDemoPayments, rotateDemoBrief, type DemoDeps } from "../src/demo.js";

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
});
