import { usdcToNative } from "@bursar/money";
import {
  annotate,
  approvals,
  authorizations,
  jobs,
  LedgerError,
  transition,
  type Db,
} from "@bursar/db";
import { jobVaultAbi, stableUuid, usdcAbi, type WalletProvider } from "@bursar/payments";
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import type { Account, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";
import { revertReason } from "./executor.js";
import { log, type Logger } from "./log.js";

export interface ReconcilerDeps {
  readonly db: Db;
  readonly client: PublicClient;
  readonly operator: WalletClient<Transport, Chain, Account>;
  readonly vault: Hex;
  readonly usdc: Hex;
  readonly wallets: WalletProvider;
  /** How long a payment can wait for a human before it's rejected. */
  readonly approvalTtlMs?: number;
  /** Extra native balance a job wallet needs to pay gas when sending money back (Arc: USDC). */
  readonly gasBufferNative?: bigint;
  /** After validBefore, how long to wait for a late settlement before treating it as unpaid. */
  readonly expiryGraceMs?: number;
  /** How often to look for leftover dust in job wallets. */
  readonly sweepIntervalMs?: number;
}

const DEFAULT_APPROVAL_TTL_MS = 2 * 60 * 60 * 1000;
/** 0.01 USDC in Arc's 18-decimal native units: far above an ERC-20 transfer's fee. */
const DEFAULT_GAS_BUFFER = 10n ** 16n;
const DEFAULT_EXPIRY_GRACE_MS = 15_000;
const STUCK_RELEASE_MS = 2 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** Leftovers below 0.01 USDC aren't worth a transaction: the fee would eat most of them. */
const SWEEP_MIN = 10_000n;
/**
 * Kept back for the sweep transfer's own fee (Arc gas is USDC). Circle reserves the MAXIMUM fee
 * (gas limit x max fee, ~0.0035 USDC observed) before sending, not the ~0.0015 actually charged.
 */
const SWEEP_FEE_RESERVE = 5_000n;
const IN_FLIGHT: ("RELEASING" | "FUNDED_WALLET" | "SIGNING" | "UNRESOLVED")[] = [
  "RELEASING",
  "FUNDED_WALLET",
  "SIGNING",
  "UNRESOLVED",
];
let lastSweepAt = 0;

type AuthorizationRow = typeof authorizations.$inferSelect;

/**
 * Resolves what the executor couldn't: UNRESOLVED payments (proved settled, or refunded to the
 * vault), approvals nobody acted on, and releases stuck in the mempool. Every step reads chain
 * state first, so running it twice, or after a crash, never refunds twice.
 */
export async function reconcileOnce(deps: ReconcilerDeps): Promise<void> {
  await expireApprovals(deps);
  await flagStuckReleases(deps);
  await pauseFrozenJobs(deps);
  const interval = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  if (Date.now() - lastSweepAt >= interval) {
    lastSweepAt = Date.now();
    await sweepWallets(deps);
  }
  const open = await deps.db
    .select()
    .from(authorizations)
    .where(and(eq(authorizations.state, "UNRESOLVED"), isNotNull(authorizations.paymentUrl)))
    .limit(20);
  for (const auth of open) {
    const logger = log.with({ authorizationId: auth.id, jobId: auth.jobId, step: "reconcile" });
    try {
      await resolve(deps, auth, logger);
    } catch (error) {
      if (error instanceof LedgerError && error.code === "STATE_CHANGED") continue;
      logger.error("reconcile step failed; will retry", error);
      await annotate(deps.db, auth.id, {
        lastError: error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
    }
  }
}

async function resolve(deps: ReconcilerDeps, auth: AuthorizationRow, logger: Logger) {
  const [job] = await deps.db.select().from(jobs).where(eq(jobs.id, auth.jobId));
  if (job?.vaultJobId === null || job?.vaultJobId === undefined || auth.vaultOpId === null) return;
  const vaultJobId = job.vaultJobId as Hex;
  const opId = auth.vaultOpId as Hex;

  // 1. Already refunded on-chain (e.g. we crashed after refund, before recording it)?
  const refunded = await deps.client.readContract({
    address: deps.vault,
    abi: refundedAbi,
    functionName: "refunded",
    args: [vaultJobId, opId],
  });
  if (refunded) {
    await transition(
      deps.db,
      auth.id,
      "RELEASED",
      { resolvedReason: "Payment failed; USDC returned to the vault and the job credited" },
      { expectFrom: "UNRESOLVED" },
    );
    logger.info("refund confirmed on-chain; budget released");
    return;
  }

  // 2. Did the payment settle after all? USDC is the source of truth.
  if (auth.payer !== null && auth.paymentNonce !== null) {
    const used = await deps.client.readContract({
      address: deps.usdc,
      abi: usdcAbi,
      functionName: "authorizationState",
      args: [auth.payer as Hex, auth.paymentNonce as Hex],
    });
    if (used) {
      await transition(
        deps.db,
        auth.id,
        "SETTLED",
        { resolvedReason: "Reconciled: USDC reports the signed payment as used" },
        { expectFrom: "UNRESOLVED" },
      );
      logger.info("unresolved payment turned out settled");
      return;
    }
    // 3. Until the signature expires, the seller could still settle it: don't touch the money.
    // Expiry is judged by CHAIN time, because that's the clock USDC checks the signature against.
    const graceMs = deps.expiryGraceMs ?? DEFAULT_EXPIRY_GRACE_MS;
    const chainNowMs = Number((await deps.client.getBlock()).timestamp) * 1000;
    if (auth.validBefore !== null && chainNowMs < auth.validBefore.getTime() + graceMs) return;
  }

  // 4. Proven unpaid: the USDC is in the job wallet. Send it back, then credit the job.
  if (job.agentWalletId === null || job.agentWalletAddress === null) return;
  const wallet = { id: job.agentWalletId, address: job.agentWalletAddress as Hex };

  if (auth.refundTransferId === null) {
    await ensureGas(deps, wallet.address, auth.amount, logger);
    const { id } = await deps.wallets.transfer({
      wallet,
      token: deps.usdc,
      to: deps.vault,
      amount: auth.amount,
      idempotencyKey: stableUuid(`bursar:refund:${auth.id}:${auth.attempts}`),
    });
    await annotate(deps.db, auth.id, { refundTransferId: id });
    logger.info("refund transfer started", { refundTransferId: id });
    return;
  }

  const status = await deps.wallets.transferStatus(auth.refundTransferId);
  if (status.state === "PENDING") return;
  if (status.state === "FAILED") {
    logger.error("refund transfer failed; retrying with a new transfer", undefined, {
      refundTransferId: auth.refundTransferId,
      alert: true,
    });
    await annotate(deps.db, auth.id, { refundTransferId: null, attempts: auth.attempts + 1 });
    return;
  }

  // 5. The USDC is back in the vault: credit the job on-chain.
  try {
    const { request } = await deps.client.simulateContract({
      address: deps.vault,
      abi: jobVaultAbi,
      functionName: "refund",
      args: [vaultJobId, opId, auth.amount],
      account: deps.operator.account,
    });
    const hash = await deps.operator.writeContract(request);
    await annotate(deps.db, auth.id, { refundTx: hash });
    const receipt = await deps.client.waitForTransactionReceipt({ hash, timeout: 30_000 });
    if (receipt.status === "success") {
      await transition(
        deps.db,
        auth.id,
        "RELEASED",
        {
          refundTx: hash,
          resolvedReason: "Payment failed; USDC returned to the vault and the job credited",
        },
        { expectFrom: "UNRESOLVED" },
      );
      logger.info("refunded to the job", { refundTx: hash });
    }
  } catch (error) {
    const reason = revertReason(error);
    if (reason === "AlreadyRefunded") return; // step 1 will record it next tick
    if (reason === "RefundNotReceived") return; // the transfer hasn't landed yet
    throw error;
  }
}

/** On Arc, gas is paid in USDC from the same balance, so a wallet holding exactly `amount` needs a top-up. */
async function ensureGas(deps: ReconcilerDeps, wallet: Hex, amount: bigint, logger: Logger) {
  const buffer = deps.gasBufferNative ?? DEFAULT_GAS_BUFFER;
  const balance = await deps.client.getBalance({ address: wallet });
  if (balance >= usdcToNative(amount) + buffer) return;
  const hash = await deps.operator.sendTransaction({ to: wallet, value: buffer });
  await deps.client.waitForTransactionReceipt({ hash, timeout: 30_000 });
  logger.info("topped up job wallet gas for the refund", { tx: hash });
}

/** Approvals nobody acted on in time are rejected, which frees their held money. */
async function expireApprovals(deps: ReconcilerDeps) {
  const cutoff = new Date(Date.now() - (deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS));
  const stale = await deps.db
    .select({ id: authorizations.id })
    .from(authorizations)
    .where(and(eq(authorizations.state, "PENDING_APPROVAL"), lt(authorizations.createdAt, cutoff)));
  for (const { id } of stale) {
    try {
      await transition(
        deps.db,
        id,
        "REJECTED",
        { resolvedReason: "Nobody approved it in time" },
        { expectFrom: "PENDING_APPROVAL" },
      );
      await deps.db
        .insert(approvals)
        .values({ authorizationId: id, verdict: "EXPIRED", note: "Approval window ran out" })
        .onConflictDoNothing();
      log.info("approval expired", { authorizationId: id });
    } catch (error) {
      if (!(error instanceof LedgerError)) throw error;
    }
  }
}

async function flagStuckReleases(deps: ReconcilerDeps) {
  const cutoff = new Date(Date.now() - STUCK_RELEASE_MS);
  const stuck = await deps.db
    .select({ id: authorizations.id, jobId: authorizations.jobId, vaultTx: authorizations.vaultTx })
    .from(authorizations)
    .where(and(eq(authorizations.state, "RELEASING"), lt(authorizations.vaultTxSentAt, cutoff)));
  for (const row of stuck) {
    log.warn("release stuck for over 2 minutes", {
      authorizationId: row.id,
      jobId: row.jobId,
      vaultTx: row.vaultTx,
      alert: true,
    });
  }
}

/**
 * A job frozen for an unexplained payout is paused on-chain too, so nothing more can leave the
 * vault. The operator can pause but never unpause: only the owner can resume the job.
 */
async function pauseFrozenJobs(deps: ReconcilerDeps) {
  const frozen = await deps.db
    .select()
    .from(jobs)
    .where(and(isNotNull(jobs.frozenReason), isNotNull(jobs.vaultJobId)));
  for (const job of frozen) {
    const onChain = await deps.client.readContract({
      address: deps.vault,
      abi: jobVaultAbi,
      functionName: "getJob",
      args: [job.vaultJobId as Hex],
    });
    if (onChain.status !== 1) continue; // already paused or closed
    try {
      await deps.client.simulateContract({
        address: deps.vault,
        abi: jobVaultAbi,
        functionName: "pause",
        args: [job.vaultJobId as Hex],
        account: deps.operator.account,
      });
      const hash = await deps.operator.writeContract({
        address: deps.vault,
        abi: jobVaultAbi,
        functionName: "pause",
        args: [job.vaultJobId as Hex],
      });
      await deps.client.waitForTransactionReceipt({ hash, timeout: 30_000 });
      log.error("frozen job paused on-chain", undefined, { jobId: job.id, tx: hash, alert: true });
    } catch (error) {
      log.error("couldn't pause a frozen job on-chain", error, { jobId: job.id, alert: true });
    }
  }
}

/**
 * Returns leftover balances (e.g. refund gas dust) from idle job wallets to the operator, who
 * paid for that gas. Never touches a wallet with a payment in flight.
 */
async function sweepWallets(deps: ReconcilerDeps) {
  const candidates = await deps.db.select().from(jobs).where(isNotNull(jobs.agentWalletId));
  for (const job of candidates) {
    const logger = log.with({ jobId: job.id, step: "sweep" });
    try {
      if (job.sweepTransferId !== null) {
        const status = await deps.wallets.transferStatus(job.sweepTransferId);
        if (status.state === "PENDING") continue;
        if (status.state === "FAILED")
          logger.error("sweep transfer failed", undefined, { id: job.sweepTransferId });
        else logger.info("swept job wallet", { tx: status.txHash });
        await deps.db.update(jobs).set({ sweepTransferId: null }).where(eq(jobs.id, job.id));
        continue;
      }
      const busy = await deps.db
        .select({ id: authorizations.id })
        .from(authorizations)
        .where(and(eq(authorizations.jobId, job.id), inArray(authorizations.state, IN_FLIGHT)))
        .limit(1);
      if (busy.length > 0) continue;
      const address = job.agentWalletAddress as Hex;
      const balance = await deps.client.readContract({
        address: deps.usdc,
        abi: usdcAbi,
        functionName: "balanceOf",
        args: [address],
      });
      if (balance < SWEEP_MIN) continue;
      const amount = balance - SWEEP_FEE_RESERVE;
      const { id } = await deps.wallets.transfer({
        wallet: { id: job.agentWalletId as string, address },
        token: deps.usdc,
        to: deps.operator.account.address,
        amount,
        // The hour bucket lets a failed sweep retry later with a fresh key; within the hour the
        // same key stops a crash-and-retry from sending twice.
        idempotencyKey: stableUuid(
          `bursar:sweep:${job.id}:${balance}:${Math.floor(Date.now() / 3_600_000)}`,
        ),
      });
      await deps.db.update(jobs).set({ sweepTransferId: id }).where(eq(jobs.id, job.id));
      logger.info("sweeping leftover balance to the operator", { amount, transferId: id });
    } catch (error) {
      logger.error("sweep failed; will retry", error);
    }
  }
}

const refundedAbi = [
  {
    type: "function",
    name: "refunded",
    stateMutability: "view",
    inputs: [
      { name: "jobId", type: "bytes32" },
      { name: "opId", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;
