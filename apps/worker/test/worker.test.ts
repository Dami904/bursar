import {
  authorizations,
  approvals,
  createDb,
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
  quote,
  usdcAbi,
  vaultOpIdFor,
} from "@bursar/payments";
import { sql, eq } from "drizzle-orm";
import type { Hex } from "viem";
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
import { indexOnce } from "../src/indexer.js";
import { reconcileOnce } from "../src/reconciler.js";
import {
  accounts,
  localWallets,
  openVaultJob,
  startChain,
  startSeller,
  type Chainside,
  type LocalSeller,
} from "./harness.js";

let chain: Chainside;
let seller: LocalSeller;
let db: Db;
let end: () => Promise<void>;
let deps: ExecutorDeps;

beforeAll(async () => {
  chain = await startChain();
  seller = await startSeller(chain);
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
    receiptTimeoutMs: 3_000,
  };
});

afterAll(async () => {
  seller.stop();
  chain.stop();
  await end();
});

beforeEach(async () => {
  seller.mode = "normal";
  await db.execute(
    sql`TRUNCATE owners, jobs, agents, credentials, payees, category_limits, decisions, authorizations, chain_events, chain_cursors, approvers, approvals, operator_runs, metrics_daily, audit_chain, audit_anchors, siwe_nonces, alert_targets, alerts, telegram_links RESTART IDENTITY CASCADE`,
  );
});

const PRICE = 100_000n; // 0.10 USDC
const index = () =>
  indexOnce({ db, client: chain.client, vault: chain.vault, deployBlock: chain.deployBlock });
const reconcile = () =>
  reconcileOnce({ ...deps, expiryGraceMs: 0, approvalTtlMs: 60_000, sweepIntervalMs: 0 });

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
async function liveJob(options: { threshold?: bigint } = {}) {
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
  await addPayee(db, owner.id, job.id, { kind: "X402_ORIGIN", value: seller.url });
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
  from: LocalSeller = seller,
) {
  const q = await quote(`${from.url}/insight`, {
    network: `eip155:${chain.client.chain?.id ?? 31337}`,
    asset: chain.usdc,
    allowPrivateHosts: true,
  });
  const result = await requestSpend(db, principal, {
    operationId,
    kind: "PURCHASE",
    payee: { kind: "X402_ORIGIN", value: q.url },
    amount: q.amount,
    reasoning: "worker test",
    payment: {
      url: q.url,
      quote: { paymentRequired: q.paymentRequired, requirements: q.requirements },
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
    const realUrl = auth.paymentUrl!;
    // Nothing answers at this URL: the payment is signed and saved, but never reaches the seller,
    // exactly as if the worker died between saving the signature and sending it.
    await db
      .update(authorizations)
      .set({ paymentUrl: "http://127.0.0.1:1/insight" })
      .where(eq(authorizations.id, auth.id));
    await runUntil(auth.id, ["SIGNING"]);
    await executeOnce(deps);
    const signed = await stateOf(auth.id);
    expect(signed.state).toBe("SIGNING");
    expect(signed.attempts).toBe(1);
    const header = (signed.paymentRequirements as { signedHeader: string }).signedHeader;

    // "Restart": the seller is reachable again.
    await db
      .update(authorizations)
      .set({ paymentUrl: realUrl, nextAttemptAt: null })
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
