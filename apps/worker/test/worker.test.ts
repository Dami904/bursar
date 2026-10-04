import {
  authorizations,
  approvals,
  committedOf,
  createDb,
  gatewayFloats,
  gatewayWithdrawals,
  decisions,
  jobs,
  verifyChain,
  type Db,
} from "@bursar/db";
import { parseUsdc } from "@bursar/money";
import {
  approvalTypedData,
  auditAnchorAbi,
  jobVaultAbi,
  paidRequest,
  quote,
  usdcAbi,
  vaultOpIdFor,
  type PaidRequest,
} from "@bursar/payments";
import { sql, eq } from "drizzle-orm";
import { parseAbi, type Hex } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// The API's own services create the job and make the decision, exactly as HTTP requests would.
import type { AgentPrincipal } from "../../api/src/auth/principal.js";
import { createAgent } from "../../api/src/services/agents.js";
import { addPayee, createJob } from "../../api/src/services/jobs.js";
import { createOwner } from "../../api/src/services/owners.js";
import { requestSpend } from "../../api/src/services/spend.js";
import { testDatabaseUrl } from "../../api/test/global-setup.js";
import { anchorOnce, type AnchorDeps } from "../src/anchor.js";
import { executeOnce, type ExecutorDeps } from "../src/executor.js";
import { floatsOnce, floatSize } from "../src/floats.js";
import { resetWithdrawScan, withdrawOnce } from "../src/withdrawals.js";
import { indexOnce } from "../src/indexer.js";
import { keepMediaOnce } from "../src/media.js";
import { reconcileOnce } from "../src/reconciler.js";
import {
  accounts,
  localWallets,
  openVaultJob,
  startChain,
  startGateway,
  startSeller,
  TINY_PNG,
  type Chainside,
  type LocalGateway,
  type LocalSeller,
  type SellerMode,
} from "./harness.js";

let chain: Chainside;
let seller: LocalSeller;
let gateway: LocalGateway;
let db: Db;
let end: () => Promise<void>;
let deps: ExecutorDeps;

beforeAll(async () => {
  chain = await startChain();
  seller = await startSeller(chain);
  gateway = await startGateway(chain);
  const created = createDb(testDatabaseUrl(), { max: 5 });
  db = created.db;
  end = () => created.client.end();
  deps = {
    db,
    client: chain.client,
    operator: chain.operator,
    vault: chain.vault,
    usdc: chain.usdc,
    wallets: localWallets(chain),
    network: "eip155:31337",
    receiptTimeoutMs: 3_000,
    allowPrivateHosts: true, // the test sellers run on 127.0.0.1
  };
});

afterAll(async () => {
  seller.stop();
  gateway.stop();
  chain.stop();
  await end();
});

beforeEach(async () => {
  seller.mode = "normal";
  seller.pollsBeforeReady = 1;
  gateway.mode = "normal";
  gateway.transfers.length = 0;
  gateway.withdrawals.length = 0;
  await db.execute(
    sql`TRUNCATE owners, jobs, agents, credentials, payees, category_limits, decisions, authorizations, chain_events, chain_cursors, approvers, approvals, operator_runs, metrics_daily, audit_chain, audit_anchors, siwe_nonces, alert_targets, alerts, telegram_links RESTART IDENTITY CASCADE`,
  );
});

const PRICE = 100_000n; // 0.10 USDC
const index = () =>
  indexOnce({ db, client: chain.client, vault: chain.vault, deployBlock: chain.deployBlock });
const reconcile = () =>
  reconcileOnce({
    ...deps,
    expiryGraceMs: 0,
    approvalTtlMs: 60_000,
    sweepIntervalMs: 0,
    unresolvedEveryMs: 0,
  });

async function stateOf(id: string) {
  const [row] = await db.select().from(authorizations).where(eq(authorizations.id, id));
  return row!;
}

async function jobRow(id: string) {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  return row!;
}

/** Runs worker ticks until the purchase reaches one of `states` (or gives up). */
async function runUntil(
  id: string,
  states: string[],
  tick: () => Promise<unknown> = () => executeOnce(deps),
  max = 12,
) {
  for (let i = 0; i < max; i += 1) {
    const row = await stateOf(id);
    if (states.includes(row.state)) return row;
    await tick();
  }
  return stateOf(id);
}

/** Owner creates a job over the API services, funds it in the vault, and the indexer activates it. */
async function liveJob(options: { threshold?: bigint; payees?: string[] } = {}) {
  const { owner } = await createOwner(db, "Studio");
  const job = await createJob(
    db,
    owner.id,
    {
      title: "Worker test",
      customer: "Test",
      budget: parseUsdc("1.00"),
      perTxCap: parseUsdc("0.50"),
      approvalThreshold: options.threshold ?? parseUsdc("0.50"),
      windowCap: parseUsdc("1.00"),
      windowSeconds: 3600,
      expiresAt: new Date(Date.now() + 86_400_000),
      delegationAllowed: true,
    },
    deps.wallets,
  );
  await openVaultJob(chain, job.vaultJobId as Hex, {
    budget: parseUsdc("1.00"),
    perTxCap: parseUsdc("0.50"),
    threshold: options.threshold ?? parseUsdc("0.50"),
    fund: parseUsdc("1.00"),
  });
  await index();
  for (const payee of options.payees ?? [seller.url]) {
    await addPayee(db, owner.id, job.id, { kind: "X402_ORIGIN", value: payee });
  }
  const { agent } = await createAgent(db, owner.id, job.id, { name: "Operator", role: "operator" });
  const principal: AgentPrincipal = {
    role: "AGENT",
    credentialId: "t",
    ownerId: owner.id,
    jobId: job.id,
    agentId: agent.id,
  };
  return { owner, job, principal };
}

/** What POST /spend/purchase does before the worker takes over: quote, decide, reserve. */
async function purchase(
  principal: AgentPrincipal,
  operationId: string,
  from: { readonly url: string } = seller,
  request?: PaidRequest,
) {
  const q = await quote(
    `${from.url}/insight`,
    {
      network: `eip155:${chain.client.chain?.id ?? 31337}`,
      asset: chain.usdc,
      allowPrivateHosts: true,
    },
    request,
  );
  const result = await requestSpend(db, principal, {
    operationId,
    kind: "PURCHASE",
    payee: { kind: "X402_ORIGIN", value: q.url },
    amount: q.amount,
    reasoning: "worker test",
    rail: q.rail,
    payment: {
      url: q.url,
      quote: {
        paymentRequired: q.paymentRequired,
        requirements: q.requirements,
        request: q.request,
      },
    },
  });
  return result.authorization!;
}

async function vaultAvailable(vaultJobId: string) {
  return chain.client.readContract({
    address: chain.vault,
    abi: jobVaultAbi,
    functionName: "available",
    args: [vaultJobId as Hex],
  });
}

describe("indexer", () => {
  it("activates a job from its vault events, and never double-counts a deposit", async () => {
    const { job } = await liveJob();
    const row = await jobRow(job.id);
    expect(row.status).toBe("ACTIVE");
    expect(row.deposited).toBe(parseUsdc("1.00"));
    expect(row.policyVersion).toBe(1);

    await db.execute(sql`DELETE FROM chain_cursors`); // re-read every block from scratch
    await index();
    expect((await jobRow(job.id)).deposited).toBe(parseUsdc("1.00"));
  });
});

describe("budget cap (mainnet, while it's new)", () => {
  it("counts an on-chain budget only up to the cap, and follows it below the cap", async () => {
    const { job } = await liveJob();
    const owner = chain.wallet(accounts.owner);
    const setBudget = async (budget: bigint) => {
      const hash = await owner.writeContract({
        address: chain.vault,
        // The owner's own call: Bursar never makes it, so its ABI lives here.
        abi: parseAbi(["function setBudget(bytes32 jobId, uint128 budget)"]),
        functionName: "setBudget",
        args: [job.vaultJobId as Hex, budget],
      });
      await chain.client.waitForTransactionReceipt({ hash });
      await indexOnce({
        db,
        client: chain.client,
        vault: chain.vault,
        deployBlock: chain.deployBlock,
        maxJobBudget: parseUsdc("2.00"),
      });
    };
    await setBudget(parseUsdc("50.00"));
    expect((await jobRow(job.id)).budget).toBe(parseUsdc("2.00"));
    await setBudget(parseUsdc("1.50"));
    expect((await jobRow(job.id)).budget).toBe(parseUsdc("1.50"));
  });
});

describe("revenue", () => {
  it("counts a customer's payment into the job as revenue, but not the owner's funding", async () => {
    const { job } = await liveJob();
    expect((await jobRow(job.id)).revenueReceived).toBe(0n); // the owner funded it
    const customer = chain.wallet(accounts.approver); // any non-owner wallet
    await chain.mint(accounts.approver.address, 250_000n);
    const approve = await customer.writeContract({
      address: chain.usdc,
      abi: usdcAbi,
      functionName: "approve",
      args: [chain.vault, 250_000n],
    });
    await chain.client.waitForTransactionReceipt({ hash: approve });
    const fund = await customer.writeContract({
      address: chain.vault,
      abi: jobVaultAbi,
      functionName: "fund",
      args: [job.vaultJobId as Hex, 250_000n],
    });
    await chain.client.waitForTransactionReceipt({ hash: fund });
    await index();
    const row = await jobRow(job.id);
    expect(row.revenueReceived).toBe(250_000n);
    expect(row.deposited).toBe(parseUsdc("1.00") + 250_000n);
    expect(row.ownerWallet).toBe(accounts.owner.address.toLowerCase());
  });
});

describe("happy path", () => {
  it("releases from the vault, pays the seller and confirms settlement on-chain", async () => {
    const { job, principal } = await liveJob();
    const auth = await purchase(principal, "op-happy-000001");
    const sellerBefore = await chain.balanceOf(accounts.seller.address);

    const done = await runUntil(auth.id, ["SETTLED"]);
    expect(done.state).toBe("SETTLED");
    expect(done.deliverable).toBe('{"insight":"paid"}');
    expect(await chain.balanceOf(accounts.seller.address)).toBe(sellerBefore + PRICE);
    expect(await chain.balanceOf(accounts.jobWallet.address)).toBe(0n);
    expect(await vaultAvailable(job.vaultJobId!)).toBe(parseUsdc("1.00") - PRICE);
    const row = await jobRow(job.id);
    expect({ settled: row.settled, reserved: row.reserved, unresolved: row.unresolved }).toEqual({
      settled: PRICE,
      reserved: 0n,
      unresolved: 0n,
    });
  });
});

describe("sellers that take a POST body", () => {
  it("quotes and pays with the same method and body, and the seller is paid once", async () => {
    const { principal } = await liveJob();
    const request = paidRequest("POST", { query: "agent budgets" });
    const before = seller.requests.length;
    const auth = await purchase(principal, "op-post-0000001", seller, request);

    const done = await runUntil(auth.id, ["SETTLED"]);
    expect(done.state).toBe("SETTLED");
    expect(done.deliverable).toBe('{"insight":"paid"}');
    // Every call this purchase made (the quote, then the paid call) was the same POST and JSON.
    const calls = seller.requests.slice(before);
    expect(calls.map((r) => r.paid)).toEqual([false, true]);
    for (const call of calls) {
      expect(call).toMatchObject({ method: "POST", body: '{"query":"agent budgets"}' });
    }
  });
});

describe("sellers that deliver later (a ticket to collect with)", () => {
  /** Skips the retry back-off between ticks. */
  const ticker = (id: string) => async () => {
    await db.update(authorizations).set({ nextAttemptAt: null }).where(eq(authorizations.id, id));
    await executeOnce(deps);
  };

  it("collects the result with the same payment, and the seller is paid once", async () => {
    const { principal } = await liveJob();
    seller.mode = "async";
    seller.pollsBeforeReady = 2;
    const request = paidRequest("POST", { prompt: "a red door" });
    const before = seller.requests.length;
    const sellerBefore = await chain.balanceOf(accounts.seller.address);
    const auth = await purchase(principal, "op-async-000001", seller, request);

    const done = await runUntil(auth.id, ["SETTLED", "UNRESOLVED"], ticker(auth.id));
    expect(done.state).toBe("SETTLED");
    expect(done.deliverable).toBe('{"id":"1","status":"completed"}');
    expect(await chain.balanceOf(accounts.seller.address)).toBe(sellerBefore + PRICE);
    // The order was a POST; every pickup was a GET of the ticket.
    const calls = seller.requests.slice(before);
    expect(calls.filter((r) => r.method === "POST" && r.paid)).toHaveLength(1);
    expect(calls.filter((r) => r.method === "GET").length).toBeGreaterThanOrEqual(3);
  });

  /**
   * A seller whose signed payments expire after 5 seconds, so a held payment's return to the vault
   * is checked without time travel (and the shared job wallet is left empty for later tests).
   */
  async function quickAsync(mode: SellerMode) {
    const quick = await startSeller(chain, PRICE, 5);
    quick.mode = mode;
    const { job, principal } = await liveJob();
    await addPayee(db, job.ownerId, job.id, { kind: "X402_ORIGIN", value: quick.url });
    return { quick, job, principal };
  }
  async function expectReturned(id: string, vaultJobId: string) {
    await new Promise((resolve) => setTimeout(resolve, 6_000)); // past validBefore
    await chain.mine();
    expect((await runUntil(id, ["RELEASED"], reconcile, 6)).state).toBe("RELEASED");
    expect(await chain.balanceOf(accounts.jobWallet.address)).toBe(0n);
    expect(await vaultAvailable(vaultJobId)).toBe(parseUsdc("1.00"));
  }

  it("never sends the payment to a ticket on another host", async () => {
    const { quick, job, principal } = await quickAsync("async-elsewhere");
    const auth = await purchase(principal, "op-async-000002", quick, paidRequest("POST", {}));
    const done = await runUntil(auth.id, ["SETTLED", "UNRESOLVED"], ticker(auth.id));
    expect(done.state).toBe("UNRESOLVED");
    expect((done.paymentRequirements as { pollUrl?: string }).pollUrl).toBeUndefined();
    // Nothing was ever sent to the other host; the order's payment comes back once it expires.
    expect(quick.requests.filter((r) => r.method === "GET")).toHaveLength(0);
    await expectReturned(auth.id, job.vaultJobId!);
    quick.stop();
  });

  it("stops waiting at the limit and holds the payment until it can't be used", async () => {
    const { quick, job, principal } = await quickAsync("async-never");
    const auth = await purchase(principal, "op-async-000003", quick, paidRequest("POST", {}));
    const tick = ticker(auth.id);
    await runUntil(auth.id, ["SIGNING"], tick);
    await tick();
    await tick();
    // The seller handed back its ticket 11 minutes ago.
    const [row] = await db.select().from(authorizations).where(eq(authorizations.id, auth.id));
    expect((row!.paymentRequirements as { pollUrl?: string }).pollUrl).toBe(`${quick.url}/jobs/1`);
    await db
      .update(authorizations)
      .set({
        paymentRequirements: {
          ...(row!.paymentRequirements as Record<string, unknown>),
          pollingSince: new Date(Date.now() - 11 * 60_000).toISOString(),
        },
      })
      .where(eq(authorizations.id, auth.id));
    const done = await runUntil(auth.id, ["SETTLED", "UNRESOLVED"], tick);
    expect(done.state).toBe("UNRESOLVED");
    expect(done.resolvedReason).toContain("wasn't ready in time");
    await expectReturned(auth.id, job.vaultJobId!);
    quick.stop();
  });
});

describe("keeping delivered media", () => {
  /** A settled purchase whose answer is `answer` (the seller's answer is replaced after the fact). */
  async function settledWith(op: string, answer: unknown) {
    const { principal } = await liveJob();
    const auth = await purchase(principal, op);
    await runUntil(auth.id, ["SETTLED"]);
    await db
      .update(authorizations)
      .set({ deliverable: JSON.stringify(answer), media: null })
      .where(eq(authorizations.id, auth.id));
    return auth.id;
  }
  const saved: string[] = [];
  const store = async (path: string, bytes: Uint8Array, contentType: string) => {
    saved.push(`${path} ${contentType} ${bytes.byteLength}`);
    return `https://blob.test/${path}`;
  };
  const mediaOf = async (id: string) =>
    (await db.select().from(authorizations).where(eq(authorizations.id, id)))[0]!.media;

  it("downloads an image once and stores it, leaving a page link alone", async () => {
    saved.length = 0;
    const id = await settledWith("op-media-000001", {
      data: [{ url: `${seller.url}/pic.png` }, { url: `${seller.url}/page.html` }],
    });
    await keepMediaOnce({ db, store, allowPrivateHosts: true });
    expect(await mediaOf(id)).toEqual([
      {
        url: `https://blob.test/media/${id}/0.png`,
        kind: "image",
        contentType: "image/png",
        bytes: TINY_PNG.byteLength,
      },
    ]);
    expect(saved).toHaveLength(1);
    // Looked at once: a second pass doesn't fetch or store again.
    await keepMediaOnce({ db, store, allowPrivateHosts: true });
    expect(saved).toHaveLength(1);
  });

  it("keeps an image the seller returned inline (base64)", async () => {
    const id = await settledWith("op-media-000002", {
      b64_json: TINY_PNG.toString("base64"),
    });
    await keepMediaOnce({ db, store, allowPrivateHosts: true });
    expect(await mediaOf(id)).toMatchObject([{ kind: "image", contentType: "image/png" }]);
  });

  it("refuses a file over the size limit", async () => {
    const id = await settledWith("op-media-000003", { url: `${seller.url}/pic.png` });
    await keepMediaOnce({ db, store, allowPrivateHosts: true, maxBytes: 10 });
    expect(await mediaOf(id)).toEqual([]);
  });

  it("never fetches a private address", async () => {
    const id = await settledWith("op-media-000004", { url: `${seller.url}/pic.png` });
    await keepMediaOnce({ db, store, allowPrivateHosts: false });
    // The link is on 127.0.0.1: refused outright, and nothing was stored.
    expect(await mediaOf(id)).toEqual([]);
  });

  it("does nothing without a store", async () => {
    const id = await settledWith("op-media-000005", { url: `${seller.url}/pic.png` });
    await keepMediaOnce({ db, store: null, allowPrivateHosts: true });
    expect(await mediaOf(id)).toBeNull();
  });
});

describe("request integrity", () => {
  it("never sends a request edited after the decision hashed it", async () => {
    const { principal } = await liveJob();
    const request = paidRequest("POST", { query: "agent budgets" });
    const auth = await purchase(principal, "op-post-0000002", seller, request);
    // Someone with database access swaps the body before the worker pays.
    const [row] = await db.select().from(authorizations).where(eq(authorizations.id, auth.id));
    await db
      .update(authorizations)
      .set({
        paymentRequirements: {
          ...(row!.paymentRequirements as Record<string, unknown>),
          request: { method: "POST", body: '{"query":"something else"}' },
        },
      })
      .where(eq(authorizations.id, auth.id));
    const before = seller.requests.length;

    const after = await runUntil(auth.id, ["SETTLED"], () => executeOnce(deps), 6);
    expect(after.state).not.toBe("SETTLED");
    expect(after.lastError).toMatch(/request no longer matches/);
    expect(seller.requests.slice(before).filter((r) => r.paid)).toHaveLength(0);

    // Put the decided request back and it goes through, paid once: nothing is left in limbo.
    // (Only the request goes back: the signed payment saved since stays as it is.)
    const [now] = await db.select().from(authorizations).where(eq(authorizations.id, auth.id));
    await db
      .update(authorizations)
      .set({
        paymentRequirements: {
          ...(now!.paymentRequirements as Record<string, unknown>),
          request: (row!.paymentRequirements as { request: unknown }).request,
        },
        nextAttemptAt: null,
      })
      .where(eq(authorizations.id, auth.id));
    const done = await runUntil(auth.id, ["SETTLED"]);
    expect(done.state).toBe("SETTLED");
    expect(seller.requests.slice(before).filter((r) => r.paid)).toHaveLength(1);
    expect(await chain.balanceOf(accounts.jobWallet.address)).toBe(0n);
  });
});

describe("failure paths", () => {
  it("a refused payment is refunded to the vault once its signature expires", async () => {
    // A seller whose signed payments expire after 3 seconds, so the test needs no time travel.
    const quick = await startSeller(chain, PRICE, 3);
    quick.mode = "refuse";
    const { job, principal } = await liveJob();
    await addPayee(db, job.ownerId, job.id, { kind: "X402_ORIGIN", value: quick.url });
    const auth = await purchase(principal, "op-refuse-00001", quick);
    expect((await runUntil(auth.id, ["UNRESOLVED"])).state).toBe("UNRESOLVED");
    expect(await chain.balanceOf(accounts.jobWallet.address)).toBe(PRICE); // released, never spent
    expect((await jobRow(job.id)).unresolved).toBe(PRICE); // still counted: nothing is assumed

    await reconcile(); // signature still valid: must not touch the money yet
    const early = await stateOf(auth.id);
    expect(early.state).toBe("UNRESOLVED");
    expect(early.refundTransferId).toBeNull(); // no refund started
    expect(await chain.balanceOf(accounts.jobWallet.address)).toBe(PRICE); // money untouched

    await new Promise((resolve) => setTimeout(resolve, 4_000)); // past validBefore
    await chain.mine(); // chain time moves with a new block (Arc produces blocks continuously)
    const done = await runUntil(auth.id, ["RELEASED"], reconcile, 6);
    expect(done.state).toBe("RELEASED");
    expect(done.refundTx).toMatch(/^0x/);
    expect(await chain.balanceOf(accounts.jobWallet.address)).toBe(0n);
    expect(await vaultAvailable(job.vaultJobId!)).toBe(parseUsdc("1.00"));
    const row = await jobRow(job.id);
    expect(row.unresolved + row.reserved + row.settled).toBe(0n);

    await reconcile(); // running again changes nothing
    expect(await vaultAvailable(job.vaultJobId!)).toBe(parseUsdc("1.00"));
    quick.stop();
  });

  it("a seller that settles but then errors is recognised as paid, not refunded", async () => {
    const { principal } = await liveJob();
    seller.mode = "settle-then-crash";
    const auth = await purchase(principal, "op-crash-000001");
    // Skip the 10 s retry back-off between ticks.
    const tickNow = async () => {
      await db
        .update(authorizations)
        .set({ nextAttemptAt: null })
        .where(eq(authorizations.id, auth.id));
      await executeOnce(deps);
    };
    const done = await runUntil(auth.id, ["SETTLED", "UNRESOLVED"], tickNow);
    expect(done.state).toBe("SETTLED");
    expect(await chain.balanceOf(accounts.jobWallet.address)).toBe(0n);
  });

  it("the owner changing the rules after the decision stops the release, and frees the budget", async () => {
    const { job, principal } = await liveJob();
    const auth = await purchase(principal, "op-stale-000001");
    const owner = chain.wallet(accounts.owner);
    const hash = await owner.writeContract({
      address: chain.vault,
      abi: jobVaultAbi,
      functionName: "setPayee",
      args: [job.vaultJobId as Hex, accounts.seller.address, true],
    });
    await chain.client.waitForTransactionReceipt({ hash });

    const done = await runUntil(auth.id, ["RELEASED", "FUNDED_WALLET", "SETTLED"]);
    expect(done.state).toBe("RELEASED");
    expect(done.resolvedReason).toMatch(/StalePolicy/);
    expect(await vaultAvailable(job.vaultJobId!)).toBe(parseUsdc("1.00"));
    expect((await jobRow(job.id)).reserved).toBe(0n);
  });
});

describe("crash recovery", () => {
  it("a release that landed but was never recorded is picked up, not paid twice", async () => {
    const { job, principal } = await liveJob();
    const auth = await purchase(principal, "op-recover-00001");
    // Simulate the worker crashing right after broadcasting: the release is on-chain, the DB
    // still says RESERVED and knows nothing about it.
    const hash = await chain.operator.writeContract({
      address: chain.vault,
      abi: jobVaultAbi,
      functionName: "release",
      args: [
        job.vaultJobId as Hex,
        vaultOpIdFor(auth.id),
        accounts.jobWallet.address,
        PRICE,
        1n,
        { approver: "0x0000000000000000000000000000000000000000", deadline: 0n, signature: "0x" },
      ],
    });
    await chain.client.waitForTransactionReceipt({ hash });

    await index(); // the indexer sees a Released it has no record of yet...
    expect((await jobRow(job.id)).frozenReason).toBeNull(); // ...but the derived op id matches

    const done = await runUntil(auth.id, ["SETTLED"]);
    expect(done.state).toBe("SETTLED");
    // Exactly one release happened: the vault paid out PRICE once.
    expect(await vaultAvailable(job.vaultJobId!)).toBe(parseUsdc("1.00") - PRICE);
  });

  it("a stuck release is replaced at the same nonce, and only one lands", async () => {
    const { job, principal } = await liveJob();
    const auth = await purchase(principal, "op-stuck-000001");
    await chain.setAutomine(false);
    try {
      await executeOnce(deps); // RESERVED → RELEASING, broadcast sits in the mempool
      const sent = await stateOf(auth.id);
      expect(sent.state).toBe("RELEASING");
      expect(sent.vaultTxNonce).not.toBeNull();
      // Pretend a minute has passed without it mining.
      await db
        .update(authorizations)
        .set({ vaultTxSentAt: new Date(Date.now() - 120_000) })
        .where(eq(authorizations.id, auth.id));
      await executeOnce(deps); // replaces it at the same nonce with higher fees
      const replaced = await stateOf(auth.id);
      expect(replaced.vaultTxNonce).toBe(sent.vaultTxNonce);
      expect(replaced.vaultTx).not.toBe(sent.vaultTx);
    } finally {
      await chain.setAutomine(true);
      await chain.mine();
    }
    const done = await runUntil(auth.id, ["SETTLED"]);
    expect(done.state).toBe("SETTLED");
    expect(await vaultAvailable(job.vaultJobId!)).toBe(parseUsdc("1.00") - PRICE);
  });
});

describe("closing the loop", () => {
  it("a crash after signing resends the SAME signed payment: the seller is paid once", async () => {
    const { principal } = await liveJob();
    const auth = await purchase(principal, "op-signed-000001");
    const sellerBefore = await chain.balanceOf(accounts.seller.address);
    // The seller is down: the payment is signed and saved, but never reaches it, exactly as if the
    // worker died between saving the signature and sending it. (The stored URL stays as decided:
    // editing it would rightly be refused as a changed request.)
    seller.mode = "drop";
    await runUntil(auth.id, ["SIGNING"]);
    await executeOnce(deps);
    const signed = await stateOf(auth.id);
    expect(signed.state).toBe("SIGNING");
    expect(signed.attempts).toBe(1);
    const header = (signed.paymentRequirements as { signedHeader: string }).signedHeader;

    // "Restart": the seller is reachable again.
    seller.mode = "normal";
    await db
      .update(authorizations)
      .set({ nextAttemptAt: null })
      .where(eq(authorizations.id, auth.id));
    const done = await runUntil(auth.id, ["SETTLED"]);
    expect(done.state).toBe("SETTLED");
    expect(done.paymentNonce).toBe(signed.paymentNonce); // not re-signed
    expect((done.paymentRequirements as { signedHeader: string }).signedHeader).toBe(header);
    expect(await chain.balanceOf(accounts.seller.address)).toBe(sellerBefore + PRICE); // paid once
  });

  it("a vault payout Bursar can't explain freezes the job, off-chain and on-chain", async () => {
    const { job, principal } = await liveJob();
    // Someone with the operator key pays out directly, outside Bursar.
    const hash = await chain.operator.writeContract({
      address: chain.vault,
      abi: jobVaultAbi,
      functionName: "release",
      args: [
        job.vaultJobId as Hex,
        `0x${"ab".repeat(32)}`,
        accounts.jobWallet.address,
        50_000n,
        1n,
        { approver: "0x0000000000000000000000000000000000000000", deadline: 0n, signature: "0x" },
      ],
    });
    await chain.client.waitForTransactionReceipt({ hash });
    await index();
    const frozen = await jobRow(job.id);
    expect(frozen.status).toBe("PAUSED");
    expect(frozen.frozenReason).toMatch(/no matching Bursar payment/);

    // No new spending in Bursar...
    const attempt = await requestSpend(db, principal, {
      operationId: "op-after-freeze-1",
      kind: "PURCHASE",
      payee: { kind: "X402_ORIGIN", value: seller.url },
      amount: PRICE,
      reasoning: "should be refused",
    });
    expect(attempt.decision.reason).toBe("JOB_NOT_ACTIVE");
    // ...and the vault is paused on-chain, so nothing more can leave it either.
    await reconcile();
    const onChain = await chain.client.readContract({
      address: chain.vault,
      abi: jobVaultAbi,
      functionName: "getJob",
      args: [job.vaultJobId as Hex],
    });
    expect(onChain.status).toBe(2); // Paused
  });

  it("sweeps leftover dust from an idle job wallet back to the operator", async () => {
    await liveJob();
    await chain.mint(accounts.jobWallet.address, 20_000n); // 0.02 USDC of stray leftovers
    // Test jobs share one wallet key, so measure from whatever it holds now.
    const walletBefore = await chain.balanceOf(accounts.jobWallet.address);
    const operatorBefore = await chain.balanceOf(accounts.operator.address);
    await reconcile(); // starts the sweep
    await reconcile(); // records it as done
    expect(await chain.balanceOf(accounts.jobWallet.address)).toBe(5_000n); // fee reserve kept
    expect(await chain.balanceOf(accounts.operator.address)).toBe(
      operatorBefore + walletBefore - 5_000n,
    );
  });
});

describe("approvals on-chain", () => {
  it("a payment above the threshold goes through with a human's EIP-712 approval", async () => {
    const { job, principal } = await liveJob({ threshold: parseUsdc("0.05") });
    const owner = chain.wallet(accounts.owner);
    const setHash = await owner.writeContract({
      address: chain.vault,
      abi: jobVaultAbi,
      functionName: "setApprover",
      args: [job.vaultJobId as Hex, accounts.approver.address, true],
    });
    await chain.client.waitForTransactionReceipt({ hash: setHash });
    await index(); // picks up the new policyVersion (2)

    const auth = await purchase(principal, "op-approve-00001");
    expect(auth.state).toBe("PENDING_APPROVAL");
    const policyVersion = (await jobRow(job.id)).policyVersion;
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const signature = await accounts.approver.signTypedData(
      approvalTypedData({
        chainId: chain.client.chain?.id ?? 31337,
        vault: chain.vault,
        vaultJobId: job.vaultJobId as Hex,
        opId: vaultOpIdFor(auth.id),
        to: accounts.jobWallet.address,
        amount: PRICE,
        policyVersion,
        deadline,
      }),
    );
    // What POST /approvals/:id stores after verifying the signature.
    await db.insert(approvals).values({
      authorizationId: auth.id,
      verdict: "APPROVED",
      approverAddress: accounts.approver.address.toLowerCase(),
      signature,
      deadline: new Date(deadline * 1000),
      policyVersion,
    });
    await db.execute(
      sql`UPDATE jobs SET pending = pending - ${PRICE.toString()}::bigint, reserved = reserved + ${PRICE.toString()}::bigint WHERE id = ${job.id}`,
    );
    await db
      .update(authorizations)
      .set({ state: "RESERVED" })
      .where(eq(authorizations.id, auth.id));

    const done = await runUntil(auth.id, ["SETTLED", "RELEASED"]);
    expect(done.state).toBe("SETTLED");
  });

  it("without an approval the vault refuses, and the money is freed", async () => {
    const { job, principal } = await liveJob({ threshold: parseUsdc("0.05") });
    const auth = await purchase(principal, "op-noapprove-001");
    // Force it past the API's approval gate: the vault must still refuse on its own.
    await db.execute(
      sql`UPDATE jobs SET pending = pending - ${PRICE.toString()}::bigint, reserved = reserved + ${PRICE.toString()}::bigint WHERE id = ${job.id}`,
    );
    await db
      .update(authorizations)
      .set({ state: "RESERVED" })
      .where(eq(authorizations.id, auth.id));

    const done = await runUntil(auth.id, ["RELEASED", "SETTLED"]);
    expect(done.state).toBe("RELEASED");
    expect(done.resolvedReason).toMatch(/ApprovalRequired/);
    expect(await vaultAvailable(job.vaultJobId!)).toBe(parseUsdc("1.00"));
  });

  it("an approval nobody acts on expires and frees the held money", async () => {
    const { job, principal } = await liveJob({ threshold: parseUsdc("0.05") });
    const auth = await purchase(principal, "op-expire-000001");
    await db
      .update(authorizations)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(authorizations.id, auth.id));
    await reconcile();
    expect((await stateOf(auth.id)).state).toBe("REJECTED");
    expect((await jobRow(job.id)).pending).toBe(0n);
  });
});

const VENDOR = "0x9f2a51b3e4d5c6a7b8c9d0e1f2a3b4c5d6e7f809" as Hex;

/** The owner allow-lists a vendor in the vault (a new policy version the indexer picks up). */
async function allowVendorOnChain(vaultJobId: string) {
  const hash = await chain.wallet(accounts.owner).writeContract({
    address: chain.vault,
    abi: jobVaultAbi,
    functionName: "setPayee",
    args: [vaultJobId as Hex, VENDOR, true],
  });
  await chain.client.waitForTransactionReceipt({ hash });
  await index();
}

async function payInvoice(principal: AgentPrincipal, operationId: string, amount = "0.25") {
  const result = await requestSpend(db, principal, {
    operationId,
    kind: "INVOICE",
    payee: { kind: "ADDRESS", value: VENDOR },
    amount: parseUsdc(amount),
    invoiceRef: "INV-7",
    reasoning: "worker test invoice",
  });
  return result.authorization!;
}

describe("invoices", () => {
  it("pays the vendor straight from the vault; the release is the payment", async () => {
    const { owner, job, principal } = await liveJob();
    await allowVendorOnChain(job.vaultJobId!);
    await addPayee(db, owner.id, job.id, { kind: "ADDRESS", value: VENDOR });
    // The chain is shared by every test here, so compare balance changes.
    const vendorBefore = await chain.balanceOf(VENDOR);
    const walletBefore = await chain.balanceOf(accounts.jobWallet.address);
    const auth = await payInvoice(principal, "op-invoice-01");

    const done = await runUntil(auth.id, ["SETTLED", "RELEASED"]);
    expect(done.state).toBe("SETTLED");
    expect(done.paymentTx).toBe(done.vaultTx);
    expect((await chain.balanceOf(VENDOR)) - vendorBefore).toBe(parseUsdc("0.25"));
    // The job wallet was never involved.
    expect(await chain.balanceOf(accounts.jobWallet.address)).toBe(walletBefore);

    await index();
    const row = await jobRow(job.id);
    expect(row.frozenReason).toBeNull(); // the payout matched a Bursar payment
    expect(row.settled).toBe(parseUsdc("0.25"));
  });

  it("if the vault refuses the vendor, nothing is paid and the budget comes back", async () => {
    const { owner, job, principal } = await liveJob();
    // Allow-listed in Bursar but NOT in the vault: the chain has the last word.
    await addPayee(db, owner.id, job.id, { kind: "ADDRESS", value: VENDOR });
    const vendorBefore = await chain.balanceOf(VENDOR);
    const auth = await payInvoice(principal, "op-invoice-02");

    const done = await runUntil(auth.id, ["SETTLED", "RELEASED"]);
    expect(done.state).toBe("RELEASED");
    expect(done.resolvedReason).toContain("PayeeNotAllowed");
    expect(await chain.balanceOf(VENDOR)).toBe(vendorBefore);
    const row = await jobRow(job.id);
    expect(row.reserved + row.settled).toBe(0n);
  });
});

describe("audit anchor", () => {
  const anchorDeps = (overrides: Partial<AnchorDeps> = {}): AnchorDeps => ({
    db,
    client: chain.client,
    operator: chain.operator,
    anchor: chain.anchor,
    intervalMs: 3_600_000,
    everyEntries: 1,
    // Generous: a slow receipt would leave the anchor SENT and change what later steps expect.
    receiptTimeoutMs: 15_000,
    ...overrides,
  });

  async function onChainHead(seq: number) {
    const [head, decisionsCovered] = await chain.client.readContract({
      address: chain.anchor,
      abi: auditAnchorAbi,
      functionName: "anchors",
      args: [BigInt(seq)],
    });
    return { head, decisionsCovered };
  }

  async function latestSeq() {
    return Number(
      await chain.client.readContract({
        address: chain.anchor,
        abi: auditAnchorAbi,
        functionName: "latestSeq",
      }),
    );
  }

  it("anchors the verified head on-chain, and only when there's something new", async () => {
    const { principal } = await liveJob();
    await purchase(principal, "op-anchor-001");
    const check = await verifyChain(db);
    const before = await latestSeq();

    const row = await anchorOnce(anchorDeps());
    expect(row).toMatchObject({ status: "CONFIRMED", chainSeq: check.headSeq, head: check.head });
    expect(await onChainHead(before + 1)).toEqual({
      head: check.head,
      decisionsCovered: BigInt(check.headSeq),
    });
    expect(await anchorOnce(anchorDeps())).toBeNull(); // nothing new since
  });

  it("waits for enough new entries or the interval", async () => {
    const { principal } = await liveJob();
    await purchase(principal, "op-anchor-101");
    await anchorOnce(anchorDeps());
    await purchase(principal, "op-anchor-102");
    const before = await latestSeq();
    expect(await anchorOnce(anchorDeps({ everyEntries: 50 }))).toBeNull();
    const row = await anchorOnce(anchorDeps({ everyEntries: 50, intervalMs: 0 }));
    expect(row?.anchorSeq).toBe(before + 1);
  });

  it("never anchors a log that fails verification", async () => {
    const { principal } = await liveJob();
    const auth = await purchase(principal, "op-anchor-201");
    await db
      .update(decisions)
      .set({ reasoning: "rewritten" })
      .where(eq(decisions.id, auth.decisionId));
    const before = await latestSeq();
    expect(await anchorOnce(anchorDeps())).toBeNull();
    expect(await latestSeq()).toBe(before);
  });
});

describe("Circle Gateway nano lane", () => {
  /** One worker tick as production runs it: index, floats, then payments (no back-off waits). */
  const tick = async () => {
    await db.update(authorizations).set({ nextAttemptAt: null });
    await db.update(gatewayFloats).set({ nextAttemptAt: null });
    await index();
    await floatsOnce(deps);
    await executeOnce(deps);
  };
  const nanoJob = () => liveJob({ payees: [gateway.url] });
  const floatsOf = (jobId: string) =>
    db.select().from(gatewayFloats).where(eq(gatewayFloats.jobId, jobId));

  it("sizes a float to the smallest of target, caps and headroom", () => {
    const job = {
      budget: 1_000_000n,
      deposited: 1_000_000n,
      perTxCap: 500_000n,
      approvalThreshold: 500_000n,
      settled: 0n,
      reserved: 1_000n,
      pending: 0n,
      unresolved: 0n,
      gatewayFunded: 0n,
      gatewayDrawn: 1_000n,
    };
    expect(floatSize(job, 100_000n)).toEqual({ amount: 100_000n, shortfall: 1_000n });
    expect(floatSize({ ...job, perTxCap: 50_000n }, 100_000n).amount).toBe(50_000n);
    expect(floatSize({ ...job, approvalThreshold: 20_000n }, 100_000n).amount).toBe(20_000n);
    // Only 0.03 of budget left beyond what's committed: the float stops there.
    expect(floatSize({ ...job, settled: 969_000n }, 100_000n).amount).toBe(31_000n);
    // Caps below the waiting payment: a float too small to cover it (the payment is released).
    const starved = floatSize({ ...job, perTxCap: 500n }, 100_000n);
    expect(starved.amount).toBeLessThan(starved.shortfall);
    expect(floatSize({ ...job, gatewayFunded: 100_000n }, 100_000n).shortfall).toBe(0n);
  });

  it("funds a float from the vault once, then pays each nano purchase from it", async () => {
    const { job, principal } = await nanoJob();
    const first = await purchase(principal, "op-nano-000001", gateway);
    expect(first.rail).toBe("GATEWAY");
    expect(first.state).toBe("RESERVED");

    const settled = await runUntil(first.id, ["SETTLED", "RELEASED"], tick, 16);
    expect(settled.state).toBe("SETTLED");
    expect(settled.gatewayTransferId).toBe(gateway.transfers[0]!.id);
    expect(settled.deliverable).toContain("nano-paid");

    const second = await purchase(principal, "op-nano-000002", gateway);
    expect((await runUntil(second.id, ["SETTLED", "RELEASED"], tick, 8)).state).toBe("SETTLED");

    for (let i = 0; i < 4 && (await floatsOf(job.id))[0]?.state !== "ACTIVE"; i += 1) {
      await tick();
    }
    const floats = await floatsOf(job.id);
    expect(floats).toHaveLength(1);
    expect(floats[0]!.amount).toBe(parseUsdc("0.10"));
    expect(floats[0]!.state).toBe("ACTIVE");

    const row = await jobRow(job.id);
    expect(row.status).toBe("ACTIVE"); // the indexer knew the float's release: no freeze
    expect(row.gatewayFunded).toBe(parseUsdc("0.10"));
    expect(row.gatewayDrawn).toBe(parseUsdc("0.002"));
    expect(row.settled).toBe(parseUsdc("0.002"));
    // The whole float counts against the budget; the nano payments inside it don't add to it.
    expect(committedOf(row)).toBe(parseUsdc("0.10"));
    expect(await vaultAvailable(job.vaultJobId!)).toBe(parseUsdc("0.90"));
    expect(gateway.transfers.map((t) => t.amount)).toEqual([1_000n, 1_000n]);
  });

  it("settles a payment Gateway took even when the seller crashed before answering", async () => {
    const { principal } = await nanoJob();
    gateway.mode = "accept-then-crash";
    const auth = await purchase(principal, "op-nano-crash-01", gateway);
    const done = await runUntil(auth.id, ["SETTLED", "RELEASED", "UNRESOLVED"], tick, 16);
    expect(done.state).toBe("SETTLED");
    expect(gateway.transfers).toHaveLength(1); // paid once, never twice
    expect(done.gatewayTransferId).toBe(gateway.transfers[0]!.id);
  });

  it("holds a refused nano payment until its signature expires, then gives it back to the float", async () => {
    const { job, principal } = await nanoJob();
    const auth = await purchase(principal, "op-nano-refuse-1", gateway);
    gateway.mode = "refuse";
    const held = await runUntil(auth.id, ["SETTLED", "RELEASED", "UNRESOLVED"], tick, 16);
    // The seller still holds the signed payment: not released while it could be submitted.
    expect(held.state).toBe("UNRESOLVED");
    await reconcile();
    expect((await stateOf(auth.id)).state).toBe("UNRESOLVED");

    await db
      .update(authorizations)
      .set({ validBefore: new Date(Date.now() - 60_000) })
      .where(eq(authorizations.id, auth.id));
    await reconcile();
    const done = await stateOf(auth.id);
    expect(done.state).toBe("RELEASED");
    expect(gateway.transfers).toHaveLength(0);
    const row = await jobRow(job.id);
    expect(row.gatewayDrawn).toBe(0n);
    expect(row.reserved).toBe(0n);
    expect(committedOf(row)).toBe(row.gatewayFunded); // the float is still there, unspent
  });

  it("returns a closed job's unspent float to its owner through Circle Gateway", async () => {
    const { job, principal } = await nanoJob();
    const auth = await purchase(principal, "op-nano-close-01", gateway);
    expect((await runUntil(auth.id, ["SETTLED"], tick, 16)).state).toBe("SETTLED");
    for (let i = 0; i < 12 && (await floatsOf(job.id))[0]?.state !== "ACTIVE"; i += 1) {
      await tick();
    }
    expect((await floatsOf(job.id))[0]?.state).toBe("ACTIVE");

    // Nothing to return while the job is open.
    resetWithdrawScan();
    await withdrawOnce(deps);
    expect(gateway.withdrawals).toHaveLength(0);

    const owner = chain.wallet(accounts.owner);
    const hash = await owner.writeContract({
      address: chain.vault,
      abi: jobVaultAbi,
      functionName: "closeJob",
      args: [job.vaultJobId as Hex],
    });
    await chain.client.waitForTransactionReceipt({ hash });
    // The indexer reads a bounded block range per call, as in the worker's loop.
    for (let i = 0; i < 10 && (await jobRow(job.id)).status !== "CLOSED"; i += 1) await index();
    expect((await jobRow(job.id)).status).toBe("CLOSED");

    // Signs and saves, gets Circle's attestation, mints: a tick or two, as in production.
    const withdrawalOf = async () =>
      (await db.select().from(gatewayWithdrawals).where(eq(gatewayWithdrawals.jobId, job.id)))[0];
    for (let i = 0; i < 6 && (await withdrawalOf())?.state !== "DONE"; i += 1) {
      resetWithdrawScan();
      await db.update(gatewayWithdrawals).set({ nextAttemptAt: null });
      await withdrawOnce(deps);
    }
    const withdrawal = await withdrawalOf();
    expect(
      withdrawal?.state,
      `withdrawal: ${withdrawal?.state ?? "none"} ${withdrawal?.lastError ?? ""}`,
    ).toBe("DONE");
    expect(withdrawal!.mintTx).toMatch(/^0x/);
    // 0.10 float, 0.001 spent: 0.099 in Gateway, less Circle's 0.00385 maximum fee.
    expect(withdrawal!.amount).toBe(parseUsdc("0.099") - 3_850n);
    expect(withdrawal!.fee).toBe(3_500n);
    expect(gateway.withdrawals).toHaveLength(1);
    expect(gateway.withdrawals[0]!.recipient.toLowerCase()).toBe(
      accounts.owner.address.toLowerCase(),
    );

    const row = await jobRow(job.id);
    expect(row.gatewayReturned).toBe(withdrawal!.amount);
    // What's left in the ledger is exactly what's left in Gateway: 350 micro-USDC of dust.
    expect(row.gatewayFunded - row.gatewayDrawn).toBe(350n);

    // Dust below Circle's fee is closed out, never withdrawn, and the job stops being checked.
    resetWithdrawScan();
    await withdrawOnce(deps);
    expect(gateway.withdrawals).toHaveLength(1);
    const after = await jobRow(job.id);
    expect(after.gatewayFunded).toBe(after.gatewayDrawn);
    expect(committedOf(after)).toBe(after.settled + after.reserved);
  });

  it("reconciles unresolved nano payments from Gateway's own records", async () => {
    const { job, principal } = await nanoJob();
    gateway.mode = "crash";
    const late = await purchase(principal, "op-nano-unres-01", gateway);
    const lost = await purchase(principal, "op-nano-unres-02", gateway);
    expect((await runUntil(late.id, ["UNRESOLVED"], tick, 20)).state).toBe("UNRESOLVED");
    expect((await runUntil(lost.id, ["UNRESOLVED"], tick, 8)).state).toBe("UNRESOLVED");

    // One of them reached Gateway after all; the other never did.
    const lateRow = await stateOf(late.id);
    gateway.transfers.push({
      id: "late-transfer",
      from: lateRow.payer!,
      nonce: lateRow.paymentNonce!,
      amount: 1_000n,
    });
    await reconcile();
    expect((await stateOf(late.id)).state).toBe("SETTLED");
    expect((await stateOf(late.id)).gatewayTransferId).toBe("late-transfer");
    expect((await stateOf(lost.id)).state).toBe("UNRESOLVED"); // Gateway may still receive it

    // Ten minutes isn't enough: the signature is still valid, so it could still arrive.
    await db
      .update(authorizations)
      .set({ updatedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(authorizations.id, lost.id));
    await reconcile();
    expect((await stateOf(lost.id)).state).toBe("UNRESOLVED");
    // Once it has expired unused, it goes back to the float.
    await db
      .update(authorizations)
      .set({ validBefore: new Date(Date.now() - 60_000) })
      .where(eq(authorizations.id, lost.id));
    await reconcile();
    expect((await stateOf(lost.id)).state).toBe("RELEASED");
    const row = await jobRow(job.id);
    expect(row.unresolved).toBe(0n);
    expect(row.gatewayDrawn).toBe(parseUsdc("0.001"));
    expect(row.settled).toBe(parseUsdc("0.001"));
  });
});
