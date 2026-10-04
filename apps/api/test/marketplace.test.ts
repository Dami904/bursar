import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { auditChain, decisions, payees, verifyChain } from "@bursar/db";
import {
  MarketplaceError,
  clearMarketplaceCache,
  registerMarketplace,
  type Listing,
} from "@bursar/payments";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { db, seedJob } from "./support.js";

const NETWORK = "eip155:5042002";
const USDC = "0x3600000000000000000000000000000000000000";

/** A seller that isn't on any job's allow-list by name; it asks 0.10 USDC for anything. */
let server: Server;
let seller = "";
let sellerHits = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    sellerHits += 1;
    res.writeHead(402, {
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
        x402Version: 2,
        resource: { url: `${seller}${req.url}`, description: "t", mimeType: "application/json" },
        accepts: [
          {
            scheme: "exact",
            network: NETWORK,
            amount: "100000",
            asset: USDC,
            payTo: "0xc140E91475BfA94C0A7531d8A0CBc018aE1d277e",
            maxTimeoutSeconds: 300,
            extra: { name: "USDC", version: "2" },
          },
        ],
      }),
    });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  seller = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

/** The test marketplace's listings, and whether it's reachable; each test sets them. */
let listed: Listing[] = [];
let marketUp = true;
const listing = (path: string, price: bigint, overrides: Partial<Listing> = {}): Listing => ({
  service: "Insight",
  provider: "Test provider",
  category: "Data Enrichment",
  method: "GET",
  url: `${seller}${path}`,
  price,
  networks: [NETWORK],
  description: "An insight",
  ...overrides,
});
registerMarketplace({
  id: "test-market",
  name: "Test Market",
  homepage: "https://market.example",
  fetchListings: async () => {
    if (!marketUp) throw new MarketplaceError("the marketplace is down");
    return listed;
  },
});
beforeEach(() => {
  clearMarketplaceCache();
  marketUp = true;
  listed = [];
  sellerHits = 0;
});

const api = createApp(db, {
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

/** A job whose allow-list holds only the test marketplace (seedJob also allows one other seller). */
async function jobWithMarket(filters?: { categories?: string[]; maxPrice?: string }) {
  const seeded = await seedJob({ budget: "1.00" });
  const added = await call(`/jobs/${seeded.job.id}/payees`, seeded.ownerKey, {
    kind: "MARKETPLACE",
    value: "test-market",
    category: "marketplace",
    ...(filters === undefined ? {} : { filters }),
  });
  expect(added.status).toBe(201);
  return seeded;
}

const buy = (operationId: string, path = "/v1/insight", maxPrice = "0.20") => ({
  operationId,
  url: `${seller}${path}`,
  maxPrice,
  reasoning: "Found it in the marketplace",
});

describe("marketplace mode", () => {
  it("an owner allows a known marketplace, with filters; an unknown one is refused", async () => {
    const { job, ownerKey } = await jobWithMarket({
      categories: ["Data Enrichment"],
      maxPrice: "0.15",
    });
    const [row] = await db
      .select()
      .from(payees)
      .where(eq(payees.jobId, job.id))
      .then((rows) => rows.filter((r) => r.kind === "MARKETPLACE"));
    expect(row).toMatchObject({ value: "test-market", category: "marketplace" });
    expect(row!.filters).toEqual({ categories: ["Data Enrichment"], maxPrice: "150000" });

    const unknown = await call(`/jobs/${job.id}/payees`, ownerKey, {
      kind: "MARKETPLACE",
      value: "no-such-market",
    });
    expect(unknown.status).toBe(400);
  });

  it("buys a listed endpoint from a seller not on the allow-list by name, and says how it was allowed", async () => {
    const { agents, job } = await jobWithMarket();
    listed = [listing("/v1/insight", 100_000n)];
    const response = await call("/spend/purchase", agents[0]!.key, buy("op-mkt-000001"));
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ result: "ALLOWED", amount: "0.10" });

    const [decision] = await db.select().from(decisions).where(eq(decisions.jobId, job.id));
    expect(decision).toMatchObject({ payee: seller, payeeSource: "marketplace:test-market" });
    // The marketplace entry's category applies, not anything the agent or the listing said.
    expect(decision!.category).toBe("marketplace");
    const [entry] = await db.select().from(auditChain).orderBy(asc(auditChain.seq));
    expect(entry!.payload).toMatchObject({ payeeSource: "marketplace:test-market" });
    expect((await verifyChain(db)).ok).toBe(true);
  });

  it("refuses an endpoint the marketplace doesn't list, without contacting the seller", async () => {
    const { agents } = await jobWithMarket();
    listed = [listing("/v1/insight", 100_000n)];
    const response = await call(
      "/spend/purchase",
      agents[0]!.key,
      buy("op-mkt-000002", "/v1/other"),
    );
    expect(response.body).toMatchObject({ result: "DENIED", reason: "PAYEE_NOT_ALLOWED" });
    expect(sellerHits).toBe(0);
  });

  it("never pays more than the listed price", async () => {
    const { agents, job } = await jobWithMarket();
    listed = [listing("/v1/insight", 50_000n)]; // the seller's 402 asks 0.10
    const response = await call("/spend/purchase", agents[0]!.key, buy("op-mkt-000003"));
    expect(response.status).toBe(422);
    expect(response.body.error).toBe("PRICE_ABOVE_LISTING");
    expect(await db.$count(decisions, eq(decisions.jobId, job.id))).toBe(0);
  });

  it("with a per-call limit, a seller charging per item may go above the listed base price, not above the limit", async () => {
    const { agents } = await jobWithMarket({ maxPrice: "0.15" });
    listed = [listing("/v1/insight", 50_000n)]; // listed at 0.05; the seller's 402 asks 0.10
    const allowed = await call("/spend/purchase", agents[0]!.key, buy("op-mkt-000006"));
    expect(allowed.body).toMatchObject({ result: "ALLOWED", amount: "0.10" });

    const { agents: others } = await jobWithMarket({ maxPrice: "0.08" });
    listed = [listing("/v1/insight", 50_000n)];
    const refused = await call("/spend/purchase", others[0]!.key, buy("op-mkt-000007"));
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ error: "PRICE_ABOVE_LISTING" });
    expect(String(refused.body.message)).toContain("limit of 0.08");
  });

  it("keeps to the owner's filters", async () => {
    const { agents } = await jobWithMarket({ categories: ["Web Search Research"] });
    listed = [listing("/v1/insight", 100_000n)]; // listed as Data Enrichment
    const response = await call("/spend/purchase", agents[0]!.key, buy("op-mkt-000004"));
    expect(response.body).toMatchObject({ result: "DENIED", reason: "PAYEE_NOT_ALLOWED" });
  });

  it("allows nothing through a marketplace it can't read", async () => {
    const { agents } = await jobWithMarket();
    marketUp = false;
    const response = await call("/spend/purchase", agents[0]!.key, buy("op-mkt-000005"));
    expect(response.body).toMatchObject({ result: "DENIED", reason: "PAYEE_NOT_ALLOWED" });
    expect(sellerHits).toBe(0);
  });

  it("lets the agent search the marketplace, within the owner's filters", async () => {
    const { agents } = await jobWithMarket({ maxPrice: "0.15" });
    listed = [
      listing("/v1/insight", 100_000n),
      listing("/v1/report", 300_000n, { service: "Report", description: "A long report" }),
    ];
    const found = await call("/spend/marketplace?q=insight", agents[0]!.key);
    expect(found.status).toBe(200);
    expect(found.body.results).toEqual([
      expect.objectContaining({ service: "Insight", price: "0.10", url: `${seller}/v1/insight` }),
    ]);

    const menu = await call("/spend/payees", agents[0]!.key);
    expect(menu.body.payees).toContainEqual(
      expect.objectContaining({
        kind: "MARKETPLACE",
        marketplace: expect.objectContaining({ name: "Test Market" }),
      }),
    );
  });

  it("says so when the marketplace sells nothing on the job's network, rather than just coming back empty", async () => {
    const { agents } = await jobWithMarket();
    listed = [{ ...listing("/v1/insight", 100_000n), networks: ["eip155:5042"] }];
    const found = await call("/spend/marketplace?q=insight", agents[0]!.key);
    expect(found.body.results).toEqual([]);
    expect(String(found.body.note)).toContain(
      "no services that take payment on this job's network",
    );

    // A real miss on a network it does sell on carries no such note.
    clearMarketplaceCache();
    listed = [listing("/v1/insight", 100_000n)];
    const miss = await call("/spend/marketplace?q=zzzz-nothing", agents[0]!.key);
    expect(miss.body.results).toEqual([]);
    expect(miss.body.note).toBeUndefined();
  });

  it("tells an agent with no marketplace on its job", async () => {
    const { agents } = await seedJob({ budget: "1.00" });
    const response = await call("/spend/marketplace?q=x", agents[0]!.key);
    expect(response).toMatchObject({ status: 404, body: { error: "NO_MARKETPLACE" } });
  });
});
