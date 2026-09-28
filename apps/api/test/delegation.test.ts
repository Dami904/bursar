import { agents, transition } from "@bursar/db";
import { parseUsdc } from "@bursar/money";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createAgent } from "../src/services/agents.js";
import { requestSpend } from "../src/services/spend.js";
import { call, db, seedJob } from "./support.js";

/** An owner-created agent with a limit, plus its key, on a seeded job. */
async function limitedParent(limit: string) {
  const seeded = await seedJob({ budget: "1.00" });
  const { agent, key } = await createAgent(db, seeded.owner.id, seeded.job.id, {
    name: "Operator",
    role: "operator",
    spendLimit: parseUsdc(limit),
  });
  return { ...seeded, parent: agent, parentKey: key };
}

async function spawn(key: string, limit: string, name = "Helper") {
  const response = await call("POST", "/spend/subagent", key, {
    name,
    role: "helper",
    spendLimit: limit,
  });
  expect(response.status).toBe(201);
  return {
    id: (response.body.agent as { id: string }).id,
    key: response.body.key as string,
  };
}

function buy(amount: string, operationId: string) {
  return {
    operationId,
    kind: "PURCHASE",
    payee: { kind: "X402_ORIGIN", value: "https://seller.example.com" },
    amount,
    reasoning: "test",
  };
}

async function committed(agentId: string) {
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
  return row!.committed;
}

describe("sub-limits are carved out of the parent's limit (G9)", () => {
  it("a helper's spending counts against its parent, so the two can't spend double", async () => {
    const { parent, parentKey } = await limitedParent("0.10");
    const helper = await spawn(parentKey, "0.10");

    const helperBuy = await call("POST", "/spend/request", helper.key, buy("0.06", "op-help-0001"));
    expect(helperBuy.body.result).toBe("ALLOWED");
    expect(await committed(parent.id)).toBe(parseUsdc("0.06"));

    // The parent's own limit would allow 0.06, but its helper already used 0.06 of the 0.10.
    const parentBuy = await call("POST", "/spend/request", parentKey, buy("0.06", "op-par-00001"));
    expect(parentBuy.body).toMatchObject({ result: "DENIED", reason: "AGENT_LIMIT_EXCEEDED" });

    // And the helper can't use the rest of its own 0.10 either: the parent has 0.04 left.
    const again = await call("POST", "/spend/request", helper.key, buy("0.05", "op-help-0002"));
    expect(again.body).toMatchObject({ result: "DENIED", reason: "AGENT_LIMIT_EXCEEDED" });
  });

  it("a grandparent's limit binds grandchildren", async () => {
    const { parentKey } = await limitedParent("0.10");
    const child = await spawn(parentKey, "0.08");
    const grandchild = await spawn(child.key, "0.08");
    await call("POST", "/spend/request", child.key, buy("0.05", "op-child-001"));
    const response = await call(
      "POST",
      "/spend/request",
      grandchild.key,
      buy("0.06", "op-grand-001"),
    );
    expect(response.body).toMatchObject({ result: "DENIED", reason: "AGENT_LIMIT_EXCEEDED" });
  });

  it("money released by a helper goes back to every limit up the tree", async () => {
    const { parent, parentKey } = await limitedParent("0.10");
    const helper = await spawn(parentKey, "0.10");
    const response = await call("POST", "/spend/request", helper.key, buy("0.06", "op-rel-00001"));
    const authorizationId = (response.body.authorization as { id: string }).id;
    await transition(db, authorizationId, "RELEASED", { resolvedReason: "test" });
    expect(await committed(parent.id)).toBe(0n);
    expect(await committed(helper.id)).toBe(0n);
  });

  it("a helper's limit must fit what the whole tree has left", async () => {
    const { parentKey } = await limitedParent("0.10");
    const child = await spawn(parentKey, "0.10");
    await call("POST", "/spend/request", parentKey, buy("0.07", "op-fit-00001"));
    const tooBig = await call("POST", "/spend/subagent", child.key, {
      name: "Grandchild",
      role: "helper",
      spendLimit: "0.05",
    });
    expect(tooBig.status).toBe(400);
  });
});

describe("replacements", () => {
  it("the replacement gets only what the old agent had left, and the old tree is revoked", async () => {
    const { ownerKey, parent, parentKey } = await limitedParent("0.10");
    const helper = await spawn(parentKey, "0.02");
    await call("POST", "/spend/request", parentKey, buy("0.03", "op-repl-0001"));

    const response = await call("POST", `/agents/${parent.id}/replace`, ownerKey, {
      name: "Operator v2",
    });
    expect(response.status).toBe(201);
    const replacement = response.body.agent as Record<string, unknown>;
    // 0.10 limit − 0.03 already committed. The 0.03 stays counted against the old agent.
    expect(replacement).toMatchObject({
      spendLimit: "0.07",
      committed: "0.00",
      role: "operator",
      replacesAgentId: parent.id,
    });

    // The old agent and its helper can't spend any more.
    for (const key of [parentKey, helper.key]) {
      expect((await call("GET", "/spend/budget", key)).status).toBe(401);
    }
    const newKey = response.body.key as string;
    const over = await call("POST", "/spend/request", newKey, buy("0.08", "op-repl-0002"));
    expect(over.body).toMatchObject({ result: "DENIED", reason: "AGENT_LIMIT_EXCEEDED" });
    const fits = await call("POST", "/spend/request", newKey, buy("0.07", "op-repl-0003"));
    expect(fits.body.result).toBe("ALLOWED");
  });

  it("can't replace the same agent twice or ask for more than was left", async () => {
    const { ownerKey, parent } = await limitedParent("0.10");
    const tooMuch = await call("POST", `/agents/${parent.id}/replace`, ownerKey, {
      name: "Greedy",
      spendLimit: "0.20",
    });
    expect(tooMuch.status).toBe(400);
    expect(
      (await call("POST", `/agents/${parent.id}/replace`, ownerKey, { name: "v2" })).status,
    ).toBe(201);
    const twice = await call("POST", `/agents/${parent.id}/replace`, ownerKey, { name: "v3" });
    expect(twice.status).toBe(409);
  });

  it("an agent can replace its own helper, and nobody else's", async () => {
    const { parentKey } = await limitedParent("0.10");
    const helper = await spawn(parentKey, "0.05");
    const sibling = await spawn(parentKey, "0.05", "Sibling");

    const replaced = await call("POST", `/spend/subagents/${helper.id}/replace`, parentKey, {
      name: "Helper v2",
    });
    expect(replaced.status).toBe(201);
    expect(replaced.body.agent).toMatchObject({
      spendLimit: "0.05",
      parentAgentId: expect.any(String),
    });

    const notMine = await call("POST", `/spend/subagents/${helper.id}/replace`, sibling.key, {
      name: "Hijack",
    });
    expect(notMine.status).toBe(404);
  });

  it("an owner can't replace another owner's agent", async () => {
    const a = await limitedParent("0.10");
    const b = await limitedParent("0.10");
    const response = await call("POST", `/agents/${a.parent.id}/replace`, b.ownerKey, {
      name: "Intruder",
    });
    expect(response.status).toBe(404);
  });
});

describe("unlimited trees", () => {
  it("helpers of an agent with no limit spend from the job budget", async () => {
    const { agents: seeded } = await seedJob({ budget: "0.10" });
    const helper = await spawn(seeded[0]!.key, "0.50");
    const response = await requestSpend(db, seeded[0]!.principal, {
      operationId: "op-unlim-001",
      kind: "PURCHASE",
      payee: { kind: "X402_ORIGIN", value: "https://seller.example.com" },
      amount: parseUsdc("0.06"),
      reasoning: "test",
    });
    expect(response.decision.result).toBe("ALLOWED");
    const helperBuy = await call("POST", "/spend/request", helper.key, buy("0.06", "op-unlim-002"));
    expect(helperBuy.body).toMatchObject({ result: "DENIED", reason: "JOB_BUDGET_EXCEEDED" });
  });
});
