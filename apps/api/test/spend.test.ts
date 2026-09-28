import { parseUsdc } from "@bursar/money";
import { authorizationStates } from "@bursar/policy";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents as agentsTable, authorizationStateEnum, categoryLimits, jobs } from "@bursar/db";
import { createAgent, revokeAgent, spawnSubagent } from "../src/services/agents.js";
import { addPayee, setCategoryLimit } from "../src/services/jobs.js";
import { requestSpend, transition } from "../src/services/spend.js";
import { SELLER, db, seedJob, spend } from "./support.js";

async function loadJob(id: string) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  return job!;
}

describe("spend decisions", () => {
  it("reserves an allowed spend and records the agent's reasoning", async () => {
    const { job, agents } = await seedJob();
    const result = await requestSpend(
      db,
      agents[0]!.principal,
      spend("0.25", "op-reason-1", "Need BTC price for scene 3"),
    );
    expect(result.decision.result).toBe("ALLOWED");
    expect(result.decision.reasoning).toBe("Need BTC price for scene 3");
    expect(result.authorization?.state).toBe("RESERVED");
    expect((await loadJob(job.id)).reserved).toBe(parseUsdc("0.25"));
  });

  it("holds money as pending when the amount needs approval", async () => {
    const { job, agents } = await seedJob({ approvalThreshold: "0.10" });
    const result = await requestSpend(db, agents[0]!.principal, spend("0.30", "op-approve-1"));
    expect(result.decision.result).toBe("NEEDS_APPROVAL");
    expect(result.authorization?.state).toBe("PENDING_APPROVAL");
    const after = await loadJob(job.id);
    expect(after.pending).toBe(parseUsdc("0.30"));
    expect(after.reserved).toBe(0n);
  });

  it("denies a payee that isn't on the allow-list without touching counters", async () => {
    const { job, agents } = await seedJob();
    const result = await requestSpend(db, agents[0]!.principal, {
      ...spend("0.10", "op-payee-1"),
      payee: { kind: "X402_ORIGIN", value: "https://evil.example.com/pay-me" },
    });
    expect(result.decision.result).toBe("DENIED");
    expect(result.decision.reason).toBe("PAYEE_NOT_ALLOWED");
    expect(result.authorization).toBeNull();
    const after = await loadJob(job.id);
    expect(after.reserved + after.pending).toBe(0n);
  });

  it("matches an allow-listed origin whatever path or case the agent uses", async () => {
    const { agents } = await seedJob();
    const result = await requestSpend(db, agents[0]!.principal, {
      ...spend("0.10", "op-origin-1"),
      payee: { kind: "X402_ORIGIN", value: `${SELLER.toUpperCase()}/v1/insight?x=1` },
    });
    expect(result.decision.result).toBe("ALLOWED");
  });

  it("denies a job that isn't active on-chain yet", async () => {
    const { job, agents } = await seedJob();
    await db.update(jobs).set({ status: "PENDING_CHAIN" }).where(eq(jobs.id, job.id));
    const result = await requestSpend(db, agents[0]!.principal, spend("0.10", "op-inactive-1"));
    expect(result.decision.reason).toBe("JOB_NOT_ACTIVE");
  });

  it("takes the category from the owner's allow-list, and enforces its limit", async () => {
    const { owner, job, agents } = await seedJob();
    await setCategoryLimit(db, owner.id, job.id, "data", parseUsdc("0.15"));
    const first = await requestSpend(db, agents[0]!.principal, spend("0.10", "op-cat-1"));
    const second = await requestSpend(db, agents[0]!.principal, spend("0.10", "op-cat-2"));
    expect(first.decision.category).toBe("data");
    expect(second.decision.reason).toBe("CATEGORY_BUDGET_EXCEEDED");
    const [limit] = await db.select().from(categoryLimits).where(eq(categoryLimits.jobId, job.id));
    expect(limit?.committed).toBe(parseUsdc("0.10"));
  });

  it("rejects an operation ID already used by another agent", async () => {
    const { agents } = await seedJob({ agents: 2 });
    await requestSpend(db, agents[0]!.principal, spend("0.10", "op-shared-1"));
    await expect(
      requestSpend(db, agents[1]!.principal, spend("0.10", "op-shared-1")),
    ).rejects.toMatchObject({
      code: "OPERATION_ID_IN_USE",
    });
  });
});

describe("agents and delegation", () => {
  it("enforces an agent's sub-limit", async () => {
    const { owner, job } = await seedJob();
    const { agent } = await createAgent(db, owner.id, job.id, {
      name: "Capped",
      role: "research",
      spendLimit: parseUsdc("0.20"),
    });
    const principal = {
      role: "AGENT" as const,
      credentialId: "t",
      ownerId: owner.id,
      jobId: job.id,
      agentId: agent.id,
    };
    expect((await requestSpend(db, principal, spend("0.15", "op-cap-1"))).decision.result).toBe(
      "ALLOWED",
    );
    expect((await requestSpend(db, principal, spend("0.10", "op-cap-2"))).decision.reason).toBe(
      "AGENT_LIMIT_EXCEEDED",
    );
  });

  it("a sub-agent spends from the same job budget and never gets new money", async () => {
    const { job, agents } = await seedJob({ budget: "0.50" });
    const parent = agents[0]!.principal;
    const { agent: child } = await spawnSubagent(db, parent, { name: "Helper", role: "voice" });
    const childPrincipal = { ...parent, agentId: child.id };
    await requestSpend(db, parent, spend("0.30", "op-parent-1"));
    const result = await requestSpend(db, childPrincipal, spend("0.30", "op-child-1"));
    expect(result.decision.reason).toBe("JOB_BUDGET_EXCEEDED");
    expect((await loadJob(job.id)).reserved).toBe(parseUsdc("0.30"));
  });

  it("revoking a parent stops its sub-agents too", async () => {
    const { owner, agents } = await seedJob();
    const parent = agents[0]!.principal;
    const { agent: child } = await spawnSubagent(db, parent, { name: "Helper", role: "voice" });
    await revokeAgent(db, owner.id, parent.agentId);
    const result = await requestSpend(
      db,
      { ...parent, agentId: child.id },
      spend("0.10", "op-orphan-1"),
    );
    expect(result.decision.reason).toBe("AGENT_REVOKED");
    const [row] = await db.select().from(agentsTable).where(eq(agentsTable.id, child.id));
    expect(row?.status).toBe("REVOKED");
  });

  it("a sub-agent's limit must fit inside a capped parent's remaining limit", async () => {
    const { owner, job } = await seedJob();
    const { agent } = await createAgent(db, owner.id, job.id, {
      name: "Capped parent",
      role: "lead",
      spendLimit: parseUsdc("0.20"),
    });
    const parent = {
      role: "AGENT" as const,
      credentialId: "t",
      ownerId: owner.id,
      jobId: job.id,
      agentId: agent.id,
    };
    await expect(
      spawnSubagent(db, parent, { name: "Greedy", role: "x", spendLimit: parseUsdc("0.30") }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("state transitions", () => {
  it("releasing a reservation returns the money to the budget", async () => {
    const { job, agents } = await seedJob();
    const { authorization } = await requestSpend(
      db,
      agents[0]!.principal,
      spend("0.40", "op-release-1"),
    );
    await transition(db, authorization!.id, "RELEASED", { resolvedReason: "seller unreachable" });
    const after = await loadJob(job.id);
    expect(after.reserved).toBe(0n);
    expect(after.settled).toBe(0n);
  });

  it("an uncertain payment keeps counting until resolved", async () => {
    const { job, agents } = await seedJob();
    const { authorization } = await requestSpend(
      db,
      agents[0]!.principal,
      spend("0.40", "op-unres-1"),
    );
    await transition(db, authorization!.id, "RELEASING");
    await transition(db, authorization!.id, "FUNDED_WALLET");
    await transition(db, authorization!.id, "SIGNING", { paymentNonce: "0xabc" });
    await transition(db, authorization!.id, "UNRESOLVED");
    let after = await loadJob(job.id);
    expect(after.unresolved).toBe(parseUsdc("0.40"));
    await transition(db, authorization!.id, "SETTLED", { paymentTx: "0xdef" });
    after = await loadJob(job.id);
    expect(after.unresolved).toBe(0n);
    expect(after.settled).toBe(parseUsdc("0.40"));
  });

  it("refuses an illegal transition", async () => {
    const { agents } = await seedJob();
    const { authorization } = await requestSpend(
      db,
      agents[0]!.principal,
      spend("0.10", "op-illegal-1"),
    );
    await expect(transition(db, authorization!.id, "SETTLED")).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
    });
  });
});

describe("schema", () => {
  it("lists the same authorization states as the policy package", () => {
    expect(authorizationStateEnum.enumValues).toEqual([...authorizationStates]);
  });

  it("stores payees in canonical form", async () => {
    const { owner, job } = await seedJob();
    const payee = await addPayee(db, owner.id, job.id, {
      kind: "ADDRESS",
      value: "0xC140E91475BFA94C0A7531D8A0CBC018AE1D277E",
    });
    expect(payee?.value).toBe("0xc140e91475bfa94c0a7531d8a0cbc018ae1d277e");
  });
});
