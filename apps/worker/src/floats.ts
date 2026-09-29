import { authorizations, committedOf, gatewayFloats, jobs, transition, type Db } from "@bursar/db";
import {
  gatewayAvailable,
  gatewayDepositCalls,
  jobVaultAbi,
  stableUuid,
  vaultFloatOpIdFor,
  type WalletProvider,
} from "@bursar/payments";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Account, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";
import { revertReason } from "./executor.js";
import { errorText, log, type Logger } from "./log.js";
import { ensureGas } from "./reconciler.js";

/**
 * Keeps each job's Circle Gateway balance topped up for its Gateway-rail (sub-cent) payments.
 *
 * A float is one vault release (its own operation id, matched by the indexer like any payment),
 * then an approve + deposit from the job wallet into Circle's GatewayWallet, then Gateway crediting
 * it. The float counts against the budget from the moment it's created, so the job can never
 * spend float and budget twice; payments then draw on it one by one, each still decided,
 * reserved and logged by Bursar.
 */

export interface FloatDeps {
  readonly db: Db;
  readonly client: PublicClient;
  readonly operator: WalletClient<Transport, Chain, Account>;
  readonly vault: Hex;
  readonly usdc: Hex;
  readonly wallets: WalletProvider;
  /** CAIP-2 network, e.g. "eip155:5042002". */
  readonly network: string;
  /** The float Bursar aims for; capped by the job's per-payment cap and approval threshold. */
  readonly floatTarget?: bigint;
  readonly gasBufferNative?: bigint;
}

type JobRow = typeof jobs.$inferSelect;
type FloatRow = typeof gatewayFloats.$inferSelect;

/** 0.10 USDC: a hundred 0.001 calls, small enough that the float itself is low-risk. */
const DEFAULT_FLOAT_TARGET = 100_000n;
const RETRY_MS = 10_000;
const NO_APPROVAL = {
  approver: "0x0000000000000000000000000000000000000000",
  deadline: 0n,
  signature: "0x",
} as const;
const IN_PROGRESS: FloatRow["state"][] = ["RELEASING", "FUNDED", "DEPOSITING", "CREDITING"];

/**
 * How big the next float should be: at least what payments are already waiting for, aiming for
 * the target, and never more than the job could otherwise spend. A float above the approval
 * threshold would need a human signature in the vault, so it stays at or below it.
 */
export function floatSize(
  job: Pick<
    JobRow,
    | "budget"
    | "deposited"
    | "perTxCap"
    | "approvalThreshold"
    | "settled"
    | "reserved"
    | "pending"
    | "unresolved"
    | "gatewayFunded"
    | "gatewayDrawn"
  >,
  target: bigint,
): { readonly amount: bigint; readonly shortfall: bigint } {
  const shortfall = job.gatewayDrawn - job.gatewayFunded;
  const needed = shortfall > 0n ? shortfall : 0n;
  const committed = committedOf(job);
  const headroom = [job.budget - committed, job.deposited - committed].reduce((a, b) =>
    a < b ? a : b,
  );
  const cap = [
    target > needed ? target : needed,
    job.perTxCap,
    job.approvalThreshold,
    needed + headroom,
  ].reduce((a, b) => (a < b ? a : b));
  return { amount: cap > 0n ? cap : 0n, shortfall: needed };
}

/** Starts floats where payments are waiting, and moves every float in progress forward. */
export async function floatsOnce(deps: FloatDeps): Promise<void> {
  await startFloats(deps);
  const open = await deps.db
    .select()
    .from(gatewayFloats)
    .where(inArray(gatewayFloats.state, IN_PROGRESS))
    .orderBy(asc(gatewayFloats.createdAt))
    .limit(10);
  for (const float of open) {
    if (float.nextAttemptAt !== null && float.nextAttemptAt.getTime() > Date.now()) continue;
    const logger = log.with({ jobId: float.jobId, floatId: float.id, step: "float" });
    try {
      await advance(deps, float, logger);
    } catch (error) {
      logger.error("float step failed; will retry", error, { state: float.state });
      await deps.db
        .update(gatewayFloats)
        .set({
          attempts: float.attempts + 1,
          lastError: errorText(error),
          nextAttemptAt: new Date(Date.now() + RETRY_MS),
          updatedAt: new Date(),
        })
        .where(eq(gatewayFloats.id, float.id));
    }
  }
}

async function startFloats(deps: FloatDeps) {
  // Jobs whose Gateway payments hold more than their floats have brought in.
  const short = await deps.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, "ACTIVE"), lt(jobs.gatewayFunded, jobs.gatewayDrawn)));
  for (const candidate of short) {
    const logger = log.with({ jobId: candidate.id, step: "float" });
    const created = await deps.db.transaction(async (tx) => {
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, candidate.id)).for("update");
      if (job === undefined || job.vaultJobId === null || job.agentWalletAddress === null) {
        return null;
      }
      const [busy] = await tx
        .select({ id: gatewayFloats.id })
        .from(gatewayFloats)
        .where(and(eq(gatewayFloats.jobId, job.id), inArray(gatewayFloats.state, IN_PROGRESS)))
        .limit(1);
      if (busy !== undefined) return null;
      const { amount, shortfall } = floatSize(job, deps.floatTarget ?? DEFAULT_FLOAT_TARGET);
      if (shortfall === 0n) return null;
      if (amount < shortfall) return { refused: true as const, job };
      const id = crypto.randomUUID();
      const [float] = await tx
        .insert(gatewayFloats)
        .values({ id, jobId: job.id, amount, vaultOpId: vaultFloatOpIdFor(id) })
        .returning();
      // Counts against the budget from now: the vault release is about to move it.
      await tx
        .update(jobs)
        .set({ gatewayFunded: sql`${jobs.gatewayFunded} + ${amount.toString()}::bigint` })
        .where(eq(jobs.id, job.id));
      return float === undefined ? null : { refused: false as const, float };
    });
    if (created === null) continue;
    if (created.refused) {
      await releaseWaiting(
        deps,
        candidate.id,
        "The job's caps and remaining budget can't fund its Gateway balance for this payment",
        logger,
      );
      continue;
    }
    logger.info("gateway float started", {
      floatId: created.float.id,
      amount: created.float.amount,
    });
  }
}

/** Gateway payments that can't be funded are released, nothing having been paid. */
async function releaseWaiting(deps: FloatDeps, jobId: string, reason: string, logger: Logger) {
  const waiting = await deps.db
    .select({ id: authorizations.id })
    .from(authorizations)
    .where(
      and(
        eq(authorizations.jobId, jobId),
        eq(authorizations.rail, "GATEWAY"),
        eq(authorizations.state, "RESERVED"),
      ),
    );
  for (const auth of waiting) {
    await transition(
      deps.db,
      auth.id,
      "RELEASED",
      { resolvedReason: reason },
      { expectFrom: "RESERVED" },
    ).catch(() => undefined);
  }
  if (waiting.length > 0) logger.warn("gateway payments released: no float possible", { reason });
}

async function setFloat(deps: FloatDeps, id: string, patch: Partial<FloatRow>) {
  await deps.db
    .update(gatewayFloats)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(gatewayFloats.id, id));
}

async function fail(
  deps: FloatDeps,
  float: FloatRow,
  reason: string,
  moved: boolean,
  logger: Logger,
) {
  await deps.db.transaction(async (tx) => {
    await tx
      .update(gatewayFloats)
      .set({ state: "FAILED", lastError: reason, updatedAt: new Date() })
      .where(eq(gatewayFloats.id, float.id));
    // Nothing left the vault: the headroom comes back. If it did leave, it stays counted.
    if (!moved) {
      await tx
        .update(jobs)
        .set({ gatewayFunded: sql`${jobs.gatewayFunded} - ${float.amount.toString()}::bigint` })
        .where(eq(jobs.id, float.jobId));
    }
  });
  if (moved)
    logger.error("gateway float failed after leaving the vault", undefined, {
      reason,
      alert: true,
    });
  else logger.warn("gateway float failed before any money moved", { reason });
  if (!moved)
    await releaseWaiting(deps, float.jobId, `The Gateway float failed: ${reason}`, logger);
}

async function advance(deps: FloatDeps, float: FloatRow, logger: Logger): Promise<void> {
  const [job] = await deps.db.select().from(jobs).where(eq(jobs.id, float.jobId));
  if (job?.vaultJobId === null || job?.vaultJobId === undefined) return;
  if (job.agentWalletId === null || job.agentWalletAddress === null) return;
  const wallet = { id: job.agentWalletId, address: job.agentWalletAddress as Hex };

  switch (float.state) {
    case "RELEASING": {
      const vaultJobId = job.vaultJobId as Hex;
      const opId = float.vaultOpId as Hex;
      const released = await deps.client.readContract({
        address: deps.vault,
        abi: jobVaultAbi,
        functionName: "releasedFor",
        args: [vaultJobId, opId],
      });
      if (released > 0n) {
        await setFloat(deps, float.id, { state: "FUNDED", attempts: 0, lastError: null });
        logger.info("gateway float released from the vault", { vaultTx: float.vaultTx });
        return;
      }
      if (float.vaultTx !== null) {
        const receipt = await deps.client
          .getTransactionReceipt({ hash: float.vaultTx as Hex })
          .catch(() => null);
        if (receipt === null) return; // still pending; releasedFor decides next tick
      }
      const args = [
        vaultJobId,
        opId,
        wallet.address,
        float.amount,
        BigInt(job.policyVersion),
        NO_APPROVAL,
      ] as const;
      try {
        await deps.client.simulateContract({
          address: deps.vault,
          abi: jobVaultAbi,
          functionName: "release",
          args,
          account: deps.operator.account,
        });
      } catch (error) {
        const reason = revertReason(error);
        if (reason === null) throw error;
        if (reason === "OpAlreadyUsed") return;
        await fail(deps, float, `The vault refused the float: ${reason}`, false, logger);
        return;
      }
      const hash = await deps.operator.writeContract({
        address: deps.vault,
        abi: jobVaultAbi,
        functionName: "release",
        args,
      });
      await setFloat(deps, float.id, { vaultTx: hash, vaultTxSentAt: new Date() });
      logger.info("gateway float release sent", { vaultTx: hash, amount: float.amount });
      await deps.client.waitForTransactionReceipt({ hash, timeout: 30_000 }).catch(() => null);
      return;
    }

    case "FUNDED": {
      // Arc gas is USDC from the same balance: top it up so the deposit moves the whole float.
      const gasTx = await ensureGas(deps, wallet.address, float.amount, logger);
      const calls = gatewayDepositCalls(deps.network, deps.usdc, float.amount);
      const { id } = await deps.wallets.execute({
        wallet,
        contract: calls.approve.contract,
        data: calls.approve.data,
        idempotencyKey: stableUuid(`bursar:float-approve:${float.id}`),
      });
      await setFloat(deps, float.id, {
        state: "DEPOSITING",
        approveTransferId: id,
        ...(gasTx === null ? {} : { gasTx }),
      });
      return;
    }

    case "DEPOSITING": {
      if (float.approveTransferId === null) return;
      if (float.depositTransferId === null) {
        const approve = await deps.wallets.transferStatus(float.approveTransferId);
        if (approve.state === "PENDING") return;
        if (approve.state === "FAILED") {
          await fail(deps, float, "The job wallet's approval for Gateway failed", true, logger);
          return;
        }
        const calls = gatewayDepositCalls(deps.network, deps.usdc, float.amount);
        const { id } = await deps.wallets.execute({
          wallet,
          contract: calls.deposit.contract,
          data: calls.deposit.data,
          idempotencyKey: stableUuid(`bursar:float-deposit:${float.id}`),
        });
        await setFloat(deps, float.id, { depositTransferId: id });
        return;
      }
      const deposit = await deps.wallets.transferStatus(float.depositTransferId);
      if (deposit.state === "PENDING") return;
      if (deposit.state === "FAILED") {
        await fail(deps, float, "The Gateway deposit failed", true, logger);
        return;
      }
      await setFloat(deps, float.id, { state: "CREDITING", depositTx: deposit.txHash });
      logger.info("gateway float deposited", { depositTx: deposit.txHash });
      return;
    }

    case "CREDITING": {
      // Circle credits a deposit once it's final (about 20 seconds on Arc testnet).
      // The executor checks the real balance before each payment; this only marks the float done
      // (and, until then, keeps a second float from starting).
      const available = await gatewayAvailable(deps.network, wallet.address);
      const waited = Date.now() - float.updatedAt.getTime();
      if (available === 0n && waited < 120_000) return;
      await setFloat(deps, float.id, { state: "ACTIVE" });
      logger.info("gateway float credited", { available });
      return;
    }

    default:
      return;
  }
}
