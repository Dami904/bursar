import { describe, expect, it } from "vitest";
import { createOwner } from "../src/services/owners.js";
import { requestSpend } from "../src/services/spend.js";
import { call, db, seedJob, spend } from "./support.js";

describe("metrics", () => {
  it("counts decisions by outcome, including overspends denied before signing", async () => {
    const { ownerKey, agents } = await seedJob({ budget: "1.00", approvalThreshold: "0.50" });
    const agent = agents[0]!.principal;
    await requestSpend(db, agent, spend("0.40", "op-metrics-01")); // allowed
    await requestSpend(db, agent, spend("0.40", "op-metrics-02")); // allowed
    await requestSpend(db, agent, spend("0.40", "op-metrics-03")); // denied: over budget
    await requestSpend(db, agent, spend("0.00", "op-metrics-04")); // denied: invalid amount

    const response = await call("GET", "/metrics", ownerKey);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      businesses: 1,
      jobs: { total: 1, live: 1 },
      decisions: {
        total: 4,
        allowed: 2,
        denied: 2,
        deniedByReason: { JOB_BUDGET_EXCEEDED: 1, INVALID_AMOUNT: 1 },
      },
    });
  });

  it("scopes an owner's metrics to their own business", async () => {
    const { agents } = await seedJob();
    await requestSpend(db, agents[0]!.principal, spend("0.10", "op-metrics-10"));
    const { key: otherKey } = await createOwner(db, "Other Studio");
    const response = await call("GET", "/metrics", otherKey);
    expect(response.body).toMatchObject({ businesses: 0, decisions: { total: 0 } });
  });

  it("serves public totals without a key, and owner metrics only with an owner key", async () => {
    const { agents } = await seedJob();
    await requestSpend(db, agents[0]!.principal, spend("0.10", "op-metrics-20"));
    const open = await call("GET", "/metrics/public", null);
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ businesses: 1, decisions: { total: 1 } });
    expect((await call("GET", "/metrics", null)).status).toBe(401);
    expect((await call("GET", "/metrics", agents[0]!.key)).status).toBe(403);
  });
});
