import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { authorizations, decisions, jobs, operatorRuns } from "@bursar/db";
import type { WalletProvider } from "@bursar/payments";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { addPayee } from "../src/services/jobs.js";
import { db, seedJob } from "./support.js";

const NETWORK = "eip155:5042002";
const USDC = "0x3600000000000000000000000000000000000000";
const account = privateKeyToAccount(`0x${"22".repeat(32)}`);

/** Local stand-in for Circle: one fixed key, so tests need no network or account. */
const fakeWallets: WalletProvider = {
  async createJobWallet() {
    return { id: "wallet-test", address: account.address };
  },
  signer() {
    return {
      address: account.address,
      signTypedData: (m) => account.signTypedData(m as Parameters<typeof account.signTypedData>[0]),
    };
  },
  transfer() {
    throw new Error("not used in API tests");
  },
  transferStatus() {
    throw new Error("not used in API tests");
  },
};

let server: Server;
let seller = "";
let sellerHits = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    sellerHits += 1;
    if (req.url === "/.well-known/x402") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          resources: [
            { url: "/v1/insight", description: "An insight" },
            { url: "https://elsewhere.example/steal", description: "Off-origin: must be dropped" },
          ],
        }),
      );
    }
    if (req.url === "/free") {
      res.writeHead(200);
      return res.end("free");
    }
    res.writeHead(402, {
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
        x402Version: 2,
        resource: { url: `${seller}${req.url}`, description: "t", mimeType: "application/json" },
        accepts: [
          {
            scheme: "exact",
            network: NETWORK,
            amount: "100000", // 0.10 USDC
            asset: USDC,
            payTo: "0xc140E91475BfA94C0A7531d8A0CBc018aE1d277e",
            maxTimeoutSeconds: 300,
            extra: { name: "USDC", version: "2" },
          },
        ],
      }),
    });
    return res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  seller = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  sellerHits = 0;
});

const api = createApp(db, {
  wallets: fakeWallets,
  payments: { network: NETWORK, asset: USDC, allowPrivateHosts: true, waitMs: 0 },
});

async function call(path: string, key: string, payload?: unknown) {
  const response = await api.request(path, {
    method: payload === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function jobWithSeller() {
  const seeded = await seedJob({ budget: "1.00" });
  await addPayee(db, seeded.owner.id, seeded.job.id, {
    kind: "X402_ORIGIN",
    value: seller,
    category: "data",
  });
  return seeded;
}

const purchase = (operationId: string, path = "/v1/insight", maxPrice = "0.20") => ({
  operationId,
  url: `${seller}${path}`,
  maxPrice,
  reasoning: "Need the insight for scene 2",
});

describe("POST /spend/purchase", () => {
  it("quotes, decides and reserves exactly the quoted price, with the quote stored", async () => {
    const { agents, job } = await jobWithSeller();
    const response = await call("/spend/purchase", agents[0]!.key, purchase("op-buy-000001"));
    expect(response.status).toBe(202); // the worker hasn't paid yet
    expect(response.body).toMatchObject({ result: "ALLOWED", amount: "0.10" });
    expect(response.body.purchase).toMatchObject({
      state: "RESERVED",
      paymentUrl: `${seller}/v1/insight`,
    });

    const [auth] = await db.select().from(authorizations).where(eq(authorizations.jobId, job.id));
    const stored = auth!.paymentRequirements as { requirements: { amount: string; payTo: string } };
    expect(stored.requirements.amount).toBe("100000");
    const [decision] = await db.select().from(decisions).where(eq(decisions.jobId, job.id));
    expect(decision!.policyVersion).toBe(0); // seedJob activates without a vault event
  });

  it("never contacts a seller that isn't allow-listed, and records the refusal", async () => {
    const { agents } = await seedJob(); // allow-lists only https://seller.example.com
    const response = await call("/spend/purchase", agents[0]!.key, purchase("op-buy-000002"));
    expect(response.body).toMatchObject({ result: "DENIED", reason: "PAYEE_NOT_ALLOWED" });
    expect(sellerHits).toBe(0);
  });

  it("refuses a quote above the agent's max price, reserving nothing", async () => {
    const { agents, job } = await jobWithSeller();
    const response = await call(
      "/spend/purchase",
      agents[0]!.key,
      purchase("op-buy-000003", "/v1/insight", "0.05"),
    );
    expect(response.status).toBe(422);
    expect(response.body.error).toBe("PRICE_ABOVE_MAX");
    expect(await db.$count(decisions, eq(decisions.jobId, job.id))).toBe(0);
  });

  it("refuses a resource that isn't paywalled", async () => {
    const { agents } = await jobWithSeller();
    const response = await call(
      "/spend/purchase",
      agents[0]!.key,
      purchase("op-buy-000004", "/free"),
    );
    expect(response.status).toBe(422);
    expect(response.body.error).toBe("QUOTE_FAILED");
  });

  it("returns the original decision on a retry with the same operation ID", async () => {
    const { agents, job } = await jobWithSeller();
    const first = await call("/spend/purchase", agents[0]!.key, purchase("op-buy-000005"));
    const retry = await call("/spend/purchase", agents[0]!.key, purchase("op-buy-000005"));
    expect(retry.body).toMatchObject({ replayed: true, decisionId: first.body.decisionId });
    expect(await db.$count(authorizations, eq(authorizations.jobId, job.id))).toBe(1);
  });
});

describe("GET /spend/authorizations/:id", () => {
  it("shows an agent its own job's purchases only", async () => {
    const mine = await jobWithSeller();
    const bought = await call("/spend/purchase", mine.agents[0]!.key, purchase("op-buy-000006"));
    const id = (bought.body.purchase as { id: string }).id;
    expect((await call(`/spend/authorizations/${id}`, mine.agents[0]!.key)).status).toBe(200);

    const other = await seedJob();
    expect((await call(`/spend/authorizations/${id}`, other.agents[0]!.key)).status).toBe(404);
  });
});

describe("POST /jobs", () => {
  it("gives each job its own wallet and a derived vault id", async () => {
    const { ownerKey } = await seedJob();
    const response = await call("/jobs", ownerKey, {
      title: "Film",
      customer: "Acme",
      budget: "5.00",
      perTxCap: "1.00",
      approvalThreshold: "0.50",
      windowCap: "2.00",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(response.status).toBe(201);
    expect(response.body.onChain).toMatchObject({
      agentWallet: account.address,
      policyVersion: 0,
    });
    expect((response.body.onChain as { vaultJobId: string }).vaultJobId).toMatch(
      /^0x[0-9a-f]{64}$/,
    );
  });
});

describe("operator endpoints", () => {
  it("lists the job's sellers for the agent", async () => {
    const { agents } = await jobWithSeller();
    const response = await call("/spend/payees", agents[0]!.key);
    const values = (response.body.payees as { value: string }[]).map((p) => p.value);
    expect(values).toContain(seller);
  });

  it("includes each seller's catalog, keeping only same-origin URLs", async () => {
    const { agents } = await jobWithSeller();
    const response = await call("/spend/payees", agents[0]!.key);
    const listed = (response.body.payees as { value: string; catalog: unknown }[]).find(
      (p) => p.value === seller,
    );
    expect(listed?.catalog).toEqual([{ url: `${seller}/v1/insight`, description: "An insight" }]);
  });

  it("quotes an allowed seller without deciding or reserving anything", async () => {
    const { agents, job } = await jobWithSeller();
    const response = await call("/spend/quote", agents[0]!.key, { url: `${seller}/v1/insight` });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ price: "0.10" });
    expect(await db.$count(decisions, eq(decisions.jobId, job.id))).toBe(0);
  });

  it("refuses to quote a seller that isn't allow-listed, without contacting it", async () => {
    const { agents } = await seedJob();
    const response = await call("/spend/quote", agents[0]!.key, { url: `${seller}/v1/insight` });
    expect(response.status).toBe(403);
    expect(sellerHits).toBe(0);
  });

  it("records an operator run and charges its model cost to the job's profit", async () => {
    const { agents, job, ownerKey } = await jobWithSeller();
    await db.update(jobs).set({ revenueReceived: 1_000_000n }).where(eq(jobs.id, job.id)); // 1.00 revenue
    const response = await call("/spend/runs", agents[0]!.key, {
      model: "gemini:gemini-3.1-flash-lite",
      brief: "test",
      steps: 3,
      inputTokens: 1000,
      outputTokens: 200,
      costMicros: 550,
      outcome: "completed",
      summary: "done",
    });
    expect(response.status).toBe(201);
    expect(await db.$count(operatorRuns, eq(operatorRuns.jobId, job.id))).toBe(1);
    const view = await call(`/jobs/${job.id}`, ownerKey);
    expect(view.body).toMatchObject({
      revenueReceived: "1.00",
      aiCost: "0.00055",
      profit: "0.99945",
    });
  });

  it("an owner key can't record runs", async () => {
    const { ownerKey } = await jobWithSeller();
    const response = await call("/spend/runs", ownerKey, {
      model: "x",
      brief: "x",
      steps: 1,
      inputTokens: 1,
      outputTokens: 1,
      costMicros: 1,
      outcome: "completed",
    });
    expect(response.status).toBe(403);
  });
});
