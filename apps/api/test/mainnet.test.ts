import { parseUsdc } from "@bursar/money";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createOwner } from "../src/services/owners.js";
import { db } from "./support.js";

/** A server with a per-job budget cap, as on Arc mainnet while it's new. */
const capped = createApp(db, { maxJobBudget: parseUsdc("5.00") });

const job = (budget: string) => ({
  title: "Film",
  customer: "Acme",
  budget,
  perTxCap: "1.00",
  approvalThreshold: "0.50",
  windowCap: "2.00",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
});

async function createJob(key: string, budget: string) {
  const response = await capped.request("/jobs", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(job(budget)),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("per-job budget cap", () => {
  it("refuses a job whose budget is above the cap, and creates one at or below it", async () => {
    const { key } = await createOwner(db, "Capped Studio");
    const tooBig = await createJob(key, "5.01");
    expect(tooBig).toMatchObject({ status: 422, body: { error: "BUDGET_ABOVE_CAP" } });
    expect(String(tooBig.body.message)).toContain("5.00 USDC");
    expect((await createJob(key, "5.00")).status).toBe(201);
  });
});
