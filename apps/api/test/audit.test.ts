import {
  GENESIS_HASH,
  auditAnchors,
  auditChain,
  authorizations,
  backfillDecisions,
  decisions,
  entryHash,
  payloadHashOf,
  requestHashOf,
  transition,
  verifyChain,
} from "@bursar/db";
import { asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { requestSpend } from "../src/services/spend.js";
import { call, db, seedJob, spend } from "./support.js";

async function entries() {
  return db.select().from(auditChain).orderBy(asc(auditChain.seq));
}

describe("hash-chained audit log (G5)", () => {
  it("records every decision, allowed or denied, and every state change, in one chain", async () => {
    const { agents } = await seedJob({ budget: "0.50" });
    const principal = agents[0]!.principal;
    const allowed = await requestSpend(db, principal, spend("0.20", "op-audit-001"));
    await requestSpend(db, principal, spend("0.90", "op-audit-002")); // denied: over the per-payment cap
    await transition(db, allowed.authorization!.id, "RELEASING");

    const log = await entries();
    expect(log.map((e) => [e.seq, e.event])).toEqual([
      [1, "decision"],
      [2, "decision"],
      [3, "transition"],
    ]);
    expect(log[0]!.prevHash).toBe(GENESIS_HASH);
    for (const [i, entry] of log.entries()) {
      const prev = i === 0 ? GENESIS_HASH : log[i - 1]!.hash;
      expect(entry.prevHash).toBe(prev);
      expect(entry.hash).toBe(entryHash(prev, entry.seq, payloadHashOf(entry.payload)));
    }
    expect(log[1]!.payload).toMatchObject({ result: "DENIED", reason: "PER_TX_CAP_EXCEEDED" });
    expect(log[2]!.payload).toMatchObject({ from: "RESERVED", to: "RELEASING", amount: "200000" });

    const check = await verifyChain(db);
    expect(check).toMatchObject({ ok: true, checked: 3, headSeq: 3, head: log[2]!.hash });
  });

  it("detects a decision edited after the fact", async () => {
    const { agents } = await seedJob();
    const first = await requestSpend(db, agents[0]!.principal, spend("0.10", "op-audit-101"));
    await requestSpend(db, agents[0]!.principal, spend("0.10", "op-audit-102"));
    // Someone with database access rewrites the agent's stated reason.
    await db
      .update(decisions)
      .set({ reasoning: "a better-sounding reason" })
      .where(eq(decisions.id, first.decision.id));
    const check = await verifyChain(db);
    expect(check).toMatchObject({
      ok: false,
      checked: 0,
      problem: { seq: 1, problem: "the decision it records was edited" },
    });
  });

  it("hashes a purchase's exact request into its decision, and detects the body edited later", async () => {
    const { agents } = await seedJob();
    const url = "https://seller.example.com/v1/search";
    const body = '{"query":"agent budgets"}';
    const result = await requestSpend(db, agents[0]!.principal, {
      ...spend("0.10", "op-audit-201"),
      payment: {
        url,
        quote: { paymentRequired: {}, requirements: {}, request: { method: "POST", body } },
      },
    });
    const requestHash = requestHashOf({ url, method: "POST", body });
    expect(result.decision.requestHash).toBe(requestHash);
    const [entry] = await entries();
    expect(entry!.payload).toMatchObject({ requestHash });
    expect((await verifyChain(db)).ok).toBe(true);

    // Someone with database access swaps the body the worker is about to send.
    await db
      .update(authorizations)
      .set({
        paymentRequirements: {
          paymentRequired: {},
          requirements: {},
          request: { method: "POST", body: '{"query":"something else"}' },
        },
      })
      .where(eq(authorizations.decisionId, result.decision.id));
    expect(await verifyChain(db)).toMatchObject({
      ok: false,
      problem: { seq: 1, problem: "the request it paid for was edited" },
    });
  });

  it("decisions without a request keep the payload they always had", async () => {
    const { agents } = await seedJob();
    await requestSpend(db, agents[0]!.principal, spend("0.10", "op-audit-202"));
    const [entry] = await entries();
    expect(entry!.payload).not.toHaveProperty("requestHash");
    expect((await verifyChain(db)).ok).toBe(true);
  });

  it("the log itself can't be edited or deleted", async () => {
    const { agents } = await seedJob();
    await requestSpend(db, agents[0]!.principal, spend("0.10", "op-audit-201"));
    await expect(
      db.execute(sql`update audit_chain set payload = '{}'::jsonb where seq = 1`),
    ).rejects.toThrow();
    await expect(db.execute(sql`delete from audit_chain where seq = 1`)).rejects.toThrow();
  });

  it("a deleted decision breaks verification", async () => {
    const { agents } = await seedJob();
    const denied = await requestSpend(db, agents[0]!.principal, spend("5.00", "op-audit-301"));
    await db.delete(decisions).where(eq(decisions.id, denied.decision.id));
    const check = await verifyChain(db);
    expect(check.problem).toEqual({ seq: 1, problem: "the decision it records was deleted" });
  });

  it("verifies a prefix, for comparing with an older anchor", async () => {
    const { agents } = await seedJob();
    await requestSpend(db, agents[0]!.principal, spend("0.10", "op-audit-401"));
    await requestSpend(db, agents[0]!.principal, spend("0.10", "op-audit-402"));
    const log = await entries();
    expect(await verifyChain(db, 1)).toMatchObject({ ok: true, headSeq: 1, head: log[0]!.hash });
  });

  it("backfills decisions made before the log existed, oldest first", async () => {
    const { agents } = await seedJob();
    await requestSpend(db, agents[0]!.principal, spend("0.10", "op-audit-501"));
    await db.execute(sql`TRUNCATE audit_chain`);
    expect(await backfillDecisions(db)).toBe(1);
    expect(await backfillDecisions(db)).toBe(0);
    expect((await verifyChain(db)).ok).toBe(true);
  });

  it("parallel decisions still form one gapless chain", async () => {
    const { agents } = await seedJob({ budget: "5.00", agents: 5 });
    await Promise.all(
      agents.map((a, i) => requestSpend(db, a.principal, spend("0.10", `op-audit-6${i}0000`))),
    );
    const check = await verifyChain(db);
    expect(check).toMatchObject({ ok: true, checked: 5 });
  });
});

describe("audit routes", () => {
  it("shows an owner their job's trail with anchor coverage, and verifies the whole log", async () => {
    const { agents, job, ownerKey } = await seedJob();
    await requestSpend(db, agents[0]!.principal, spend("0.10", "op-audit-701"));
    const log = await entries();
    await db.insert(auditAnchors).values({
      anchorSeq: 1,
      chainSeq: 1,
      head: log[0]!.hash,
      status: "CONFIRMED",
      txHash: "0xabc",
    });

    const trail = await call("GET", `/jobs/${job.id}/audit`, ownerKey);
    expect(trail.status).toBe(200);
    expect(trail.body.entries).toMatchObject([
      { seq: 1, event: "decision", anchor: { anchorSeq: 1, txHash: "0xabc" } },
    ]);

    const status = await call("GET", "/audit/status", ownerKey);
    expect(status.body).toMatchObject({ ok: true, entries: 1, matchesAnchor: true });
  });

  it("reports a log that no longer matches its anchor", async () => {
    const { agents, ownerKey } = await seedJob();
    await requestSpend(db, agents[0]!.principal, spend("0.10", "op-audit-801"));
    await db.insert(auditAnchors).values({
      anchorSeq: 1,
      chainSeq: 1,
      head: `0x${"ab".repeat(32)}`, // not what the log reproduces
      status: "CONFIRMED",
    });
    const status = await call("GET", "/audit/status", ownerKey);
    expect(status.body).toMatchObject({ ok: false, matchesAnchor: false });
  });

  it("keeps other owners out of a job's trail", async () => {
    const a = await seedJob();
    const b = await seedJob();
    expect((await call("GET", `/jobs/${a.job.id}/audit`, b.ownerKey)).status).toBe(404);
    expect((await call("GET", "/audit/status", a.agents[0]!.key)).status).toBe(403);
  });
});
