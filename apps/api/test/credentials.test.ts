import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { decisions, jobs } from "@bursar/db";
import { createOwner } from "../src/services/owners.js";
import { SELLER, call, db, seedJob } from "./support.js";

const spendPayload = (operationId: string, amount = "0.10") => ({
  operationId,
  payee: { kind: "X402_ORIGIN", value: SELLER },
  amount,
  reasoning: "test",
});

describe("keys", () => {
  it("rejects a missing, malformed or unknown key", async () => {
    expect((await call("GET", "/spend/budget", null)).status).toBe(401);
    expect((await call("GET", "/spend/budget", "not-a-key")).status).toBe(401);
    const unknown = `bsr_agt_${"A".repeat(43)}`;
    expect((await call("GET", "/spend/budget", unknown)).status).toBe(401);
  });

  it("leaves /health open", async () => {
    expect((await call("GET", "/health", null)).status).toBe(200);
  });
});

describe("an agent key can only spend (G1)", () => {
  it("can't create jobs, read the owner's view, add agents or revoke anyone", async () => {
    const { job, agents } = await seedJob({ agents: 2 });
    const key = agents[0]!.key;
    const jobBody = {
      title: "x",
      customer: "x",
      budget: "100.00",
      perTxCap: "100.00",
      approvalThreshold: "100.00",
      windowCap: "100.00",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    expect((await call("POST", "/jobs", key, jobBody)).status).toBe(403);
    expect((await call("GET", `/jobs/${job.id}`, key)).status).toBe(403);
    expect(
      (await call("POST", `/jobs/${job.id}/agents`, key, { name: "x", role: "x" })).status,
    ).toBe(403);
    expect(
      (
        await call("POST", `/jobs/${job.id}/payees`, key, {
          kind: "ADDRESS",
          value: `0x${"1".repeat(40)}`,
        })
      ).status,
    ).toBe(403);
    expect((await call("POST", `/agents/${agents[1]!.agent.id}/revoke`, key)).status).toBe(403);
  });

  it("an owner key can't spend as an agent", async () => {
    const { ownerKey } = await seedJob();
    expect(
      (await call("POST", "/spend/request", ownerKey, spendPayload("op-owner-1"))).status,
    ).toBe(403);
  });
});

describe("identity comes from the key, never the body (G2)", () => {
  it("ignores an agentId in the request body", async () => {
    const { job, agents } = await seedJob({ agents: 2 });
    const [me, other] = agents;
    const response = await call("POST", "/spend/request", me!.key, {
      ...spendPayload("op-impostor-1"),
      agentId: other!.agent.id,
    });
    expect(response.status).toBe(201);
    const [row] = await db.select().from(decisions).where(eq(decisions.jobId, job.id));
    expect(row?.agentId).toBe(me!.agent.id);
  });

  it("a revoked agent's key stops working immediately", async () => {
    const { ownerKey, agents } = await seedJob();
    const agent = agents[0]!;
    expect(
      (await call("POST", "/spend/request", agent.key, spendPayload("op-live-1"))).status,
    ).toBe(201);
    expect((await call("POST", `/agents/${agent.agent.id}/revoke`, ownerKey)).status).toBe(200);
    expect(
      (await call("POST", "/spend/request", agent.key, spendPayload("op-dead-1"))).status,
    ).toBe(401);
  });

  it("revoking a parent kills its sub-agent's key too", async () => {
    const { ownerKey, agents } = await seedJob();
    const parent = agents[0]!;
    const spawned = await call("POST", "/spend/subagent", parent.key, {
      name: "Helper",
      role: "voice",
    });
    expect(spawned.status).toBe(201);
    const childKey = spawned.body.key as string;
    await call("POST", `/agents/${parent.agent.id}/revoke`, ownerKey);
    expect((await call("GET", "/spend/budget", childKey)).status).toBe(401);
  });
});

describe("owners only see their own jobs (G4)", () => {
  it("another owner gets 404, not 403, for a job that isn't theirs", async () => {
    const { job, agents } = await seedJob();
    const { key: otherKey } = await createOwner(db, "Other Studio");
    expect((await call("GET", `/jobs/${job.id}`, otherKey)).status).toBe(404);
    expect(
      (await call("POST", `/jobs/${job.id}/agents`, otherKey, { name: "x", role: "x" })).status,
    ).toBe(404);
    expect((await call("POST", `/agents/${agents[0]!.agent.id}/revoke`, otherKey)).status).toBe(
      404,
    );
  });
});

describe("job limits that can't work", () => {
  const body = (over: Record<string, string>) => ({
    title: "Film",
    customer: "Acme",
    budget: "5.00",
    perTxCap: "1.00",
    approvalThreshold: "0.50",
    windowCap: "2.00",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...over,
  });

  it("refuses a window cap below the per-payment cap, which could never fit a payment", async () => {
    const { key } = await createOwner(db, "Fresh Studio");
    const refused = await call("POST", "/jobs", key, body({ windowCap: "0.50" }));
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("windowCap can't be below perTxCap");
    // Equal is fine.
    expect((await call("POST", "/jobs", key, body({ windowCap: "1.00" }))).status).toBe(201);
  });
});

describe("unfreezing", () => {
  it("refuses a job that never opened in the vault (its id taken by another wallet)", async () => {
    const { job, ownerKey } = await seedJob();
    await db
      .update(jobs)
      .set({ status: "PENDING_CHAIN", frozenReason: "created on-chain by another wallet" })
      .where(eq(jobs.id, job.id));
    const refused = await call("POST", `/jobs/${job.id}/unfreeze`, ownerKey);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("NEVER_OPENED");
    const [still] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(still?.frozenReason).not.toBeNull();
  });

  it("lifts the freeze on an open job", async () => {
    const { job, ownerKey } = await seedJob();
    await db
      .update(jobs)
      .set({ status: "ACTIVE", frozenReason: "unexplained payout" })
      .where(eq(jobs.id, job.id));
    expect((await call("POST", `/jobs/${job.id}/unfreeze`, ownerKey)).status).toBe(200);
    const [after] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(after?.frozenReason).toBeNull();
  });
});

describe("HTTP flow", () => {
  it("an owner creates a job that stays inactive until the chain confirms it", async () => {
    const { key: ownerKey } = await createOwner(db, "Fresh Studio");
    const created = await call("POST", "/jobs", ownerKey, {
      title: "Film",
      customer: "Acme",
      budget: "5.00",
      perTxCap: "1.00",
      approvalThreshold: "0.50",
      windowCap: "2.00",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: "DRAFT", budget: "5.00", remaining: "5.00" });

    const jobId = created.body.id as string;
    await call("POST", `/jobs/${jobId}/payees`, ownerKey, { kind: "X402_ORIGIN", value: SELLER });
    const agent = await call("POST", `/jobs/${jobId}/agents`, ownerKey, {
      name: "Operator",
      role: "operator",
    });
    const denied = await call(
      "POST",
      "/spend/request",
      agent.body.key as string,
      spendPayload("op-draft-1"),
    );
    expect(denied.body).toMatchObject({ result: "DENIED", reason: "JOB_NOT_ACTIVE" });
  });

  it("returns amounts as decimal strings and a check trace", async () => {
    const { agents } = await seedJob();
    const response = await call(
      "POST",
      "/spend/request",
      agents[0]!.key,
      spendPayload("op-shape-1", "0.25"),
    );
    expect(response.body).toMatchObject({
      result: "ALLOWED",
      amount: "0.25",
      remaining: "0.75",
      replayed: false,
    });
    expect(Array.isArray(response.body.checks)).toBe(true);
    const retry = await call(
      "POST",
      "/spend/request",
      agents[0]!.key,
      spendPayload("op-shape-1", "0.25"),
    );
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ replayed: true, decisionId: response.body.decisionId });
  });

  it("rejects malformed amounts and bodies with a clear message", async () => {
    const { agents } = await seedJob();
    const bad = await call(
      "POST",
      "/spend/request",
      agents[0]!.key,
      spendPayload("op-bad-1", "0.1234567"),
    );
    expect(bad.status).toBe(400);
    expect(String(bad.body.message)).toMatch(/amount/);
  });
});
