import {
  authorizations,
  chainCursors,
  chainEvents,
  committedOf,
  gatewayFloats,
  jobs,
  type Db,
  type Tx,
} from "@bursar/db";
import { jobVaultAbi, vaultFloatOpIdFor, vaultOpIdFor, vaultStatus } from "@bursar/payments";
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Hex, Log, PublicClient } from "viem";
import { decodeEventLog } from "viem";
import { log } from "./log.js";

const CURSOR = "job-vault";
/** Arc limits eth_getLogs ranges; small batches also keep each transaction short. */
const MAX_BLOCKS_PER_BATCH = 2_000n;

export interface IndexerDeps {
  readonly db: Db;
  readonly client: PublicClient;
  readonly vault: Hex;
  readonly deployBlock: bigint;
  /**
   * The most any one job may spend (mainnet, while it's new). An owner can raise a budget on-chain
   * past it; Bursar then counts only up to the cap, and the rest goes back to them at close.
   */
  readonly maxJobBudget?: bigint | undefined;
}

type Decoded = { eventName: string; args: Record<string, unknown> };

const bigintParam = (value: bigint) => sql`${value.toString()}::bigint`;

/**
 * Reads JobVault events from where it left off and applies each exactly once. The event row and
 * its effect are written in one transaction, keyed by (tx hash, log index), so a crash or a
 * re-read of the same blocks can't double-count a deposit.
 *
 * Returns the number of blocks it advanced.
 */
export async function indexOnce(deps: IndexerDeps): Promise<bigint> {
  const { db, client, vault, deployBlock } = deps;
  await backfillOwners(db, client, vault);
  const [cursor] = await db.select().from(chainCursors).where(eq(chainCursors.name, CURSOR));
  const from = cursor === undefined ? deployBlock : BigInt(cursor.block) + 1n;
  const head = await client.getBlockNumber();
  if (from > head) return 0n;
  const to = head - from > MAX_BLOCKS_PER_BATCH ? from + MAX_BLOCKS_PER_BATCH : head;

  const logs = await client.getLogs({ address: vault, fromBlock: from, toBlock: to });
  await db.transaction(async (tx) => {
    for (const entry of logs) {
      await applyLog(tx, entry, deps.maxJobBudget);
    }
    await tx
      .insert(chainCursors)
      .values({ name: CURSOR, block: Number(to) })
      .onConflictDoUpdate({
        target: chainCursors.name,
        set: { block: Number(to), updatedAt: new Date() },
      });
  });
  if (logs.length > 0) log.info("indexed vault events", { from, to, events: logs.length });
  return to - from + 1n;
}

async function applyLog(tx: Tx, entry: Log, maxJobBudget?: bigint): Promise<void> {
  if (entry.transactionHash === null || entry.logIndex === null || entry.blockNumber === null) {
    return; // pending logs have no position yet
  }
  let decoded: Decoded;
  try {
    decoded = decodeEventLog({
      abi: jobVaultAbi,
      data: entry.data,
      topics: entry.topics,
    }) as Decoded;
  } catch {
    return; // not one of ours
  }
  const vaultJobId = String(decoded.args.jobId ?? "");
  const [inserted] = await tx
    .insert(chainEvents)
    .values({
      txHash: entry.transactionHash,
      logIndex: entry.logIndex,
      blockNumber: Number(entry.blockNumber),
      eventName: decoded.eventName,
      vaultJobId,
    })
    .onConflictDoNothing()
    .returning({ id: chainEvents.id });
  if (inserted === undefined) return; // already applied

  const [job] = await tx.select().from(jobs).where(eq(jobs.vaultJobId, vaultJobId)).for("update");
  if (job === undefined) return; // a vault job Bursar didn't create (e.g. a manual test)
  const args = decoded.args;
  const version = typeof args.policyVersion === "bigint" ? Number(args.policyVersion) : null;
  const bumpVersion =
    version === null ? {} : { policyVersion: sql`greatest(${jobs.policyVersion}, ${version})` };

  switch (decoded.eventName) {
    case "JobCreated":
      await tx
        .update(jobs)
        .set({
          policyVersion: sql`greatest(${jobs.policyVersion}, 1)`,
          ownerWallet: String(args.owner).toLowerCase(),
        })
        .where(eq(jobs.id, job.id));
      await tx
        .update(jobs)
        .set({ status: "ACTIVE" })
        .where(and(eq(jobs.id, job.id), inArray(jobs.status, ["DRAFT", "PENDING_CHAIN"])));
      log.info("job live on-chain", { jobId: job.id, vaultJobId });
      break;
    case "Funded": {
      // The owner funds the budget; anyone else paying in is a customer paying revenue.
      const amount = args.amount as bigint;
      const fromOwner =
        job.ownerWallet !== null && String(args.from).toLowerCase() === job.ownerWallet;
      await tx
        .update(jobs)
        .set({
          deposited: sql`${jobs.deposited} + ${bigintParam(amount)}`,
          ...(fromOwner || job.ownerWallet === null
            ? {}
            : { revenueReceived: sql`${jobs.revenueReceived} + ${bigintParam(amount)}` }),
        })
        .where(eq(jobs.id, job.id));
      if (!fromOwner && job.ownerWallet !== null) {
        log.info("customer revenue received", { jobId: job.id, from: args.from, amount });
      }
      break;
    }
    case "BudgetChanged": {
      // Mirror the owner's on-chain budget so off-chain decisions match what the vault will allow.
      const onChain = args.budget as bigint;
      const budget = maxJobBudget !== undefined && onChain > maxJobBudget ? maxJobBudget : onChain;
      if (budget !== onChain) {
        log.warn("on-chain budget is above the cap; counting only up to the cap", {
          jobId: job.id,
          onChain,
          cap: maxJobBudget,
        });
      }
      const committed = committedOf(job);
      if (budget < committed) {
        log.warn("on-chain budget is below what's already committed; keeping the higher budget", {
          jobId: job.id,
          budget,
          committed,
        });
        await tx.update(jobs).set(bumpVersion).where(eq(jobs.id, job.id));
      } else {
        await tx
          .update(jobs)
          .set({ budget, ...bumpVersion })
          .where(eq(jobs.id, job.id));
      }
      break;
    }
    case "LimitsChanged":
      await tx
        .update(jobs)
        .set({
          perTxCap: args.perTxCap as bigint,
          approvalThreshold: args.approvalThreshold as bigint,
          windowCap: args.windowCap as bigint,
          windowSeconds: Number(args.window as bigint),
          ...bumpVersion,
        })
        .where(eq(jobs.id, job.id));
      break;
    case "StatusChanged": {
      const status = vaultStatus[Number(args.status) as keyof typeof vaultStatus];
      const mapped = status === "ACTIVE" ? "ACTIVE" : status === "PAUSED" ? "PAUSED" : "CLOSED";
      await tx
        .update(jobs)
        .set({ status: mapped, ...bumpVersion })
        .where(eq(jobs.id, job.id));
      log.info("job status changed on-chain", { jobId: job.id, status: mapped });
      break;
    }
    case "PayeeChanged":
    case "ApproverChanged":
      await tx.update(jobs).set(bumpVersion).where(eq(jobs.id, job.id));
      break;
    case "Released": {
      // Every payout must belong to one of this job's payments. Operation ids are derived from
      // the authorization id, so even a release Bursar sent but never recorded still matches.
      const opId = String(args.opId).toLowerCase();
      const payments = await tx
        .select({ id: authorizations.id })
        .from(authorizations)
        .where(eq(authorizations.jobId, job.id));
      // Gateway floats are releases too: the job's money moving into its own Gateway balance.
      const floats = await tx
        .select({ id: gatewayFloats.id })
        .from(gatewayFloats)
        .where(eq(gatewayFloats.jobId, job.id));
      const known =
        payments.some((p) => vaultOpIdFor(p.id).toLowerCase() === opId) ||
        floats.some((f) => vaultFloatOpIdFor(f.id).toLowerCase() === opId);
      if (!known) {
        const reason = `The vault paid ${String(args.amount)} base units to ${String(args.to)} (operation ${opId}, tx ${entry.transactionHash}) with no matching Bursar payment`;
        await tx
          .update(jobs)
          .set({ status: "PAUSED", frozenReason: reason })
          .where(eq(jobs.id, job.id));
        log.error("unexplained vault payout: job frozen", undefined, {
          jobId: job.id,
          vaultJobId,
          opId,
          to: args.to,
          amount: args.amount,
          txHash: entry.transactionHash,
          alert: true,
        });
      }
      break;
    }
    default:
      // Refunded, Withdrawn: the reconciler reads these from chain state.
      break;
  }
}

/**
 * Jobs that went live before Bursar recorded owner wallets have none, so customer payments into
 * them couldn't be told apart from the owner's funding. Read the owner from the vault itself.
 */
async function backfillOwners(db: Db, client: PublicClient, vault: Hex): Promise<void> {
  const missing = await db
    .select({ id: jobs.id, vaultJobId: jobs.vaultJobId })
    .from(jobs)
    .where(and(isNull(jobs.ownerWallet), isNotNull(jobs.vaultJobId), ne(jobs.status, "DRAFT")));
  for (const job of missing) {
    const onChain = await client.readContract({
      address: vault,
      abi: jobVaultAbi,
      functionName: "getJob",
      args: [job.vaultJobId as Hex],
    });
    if (/^0x0{40}$/i.test(onChain.owner)) continue;
    await db
      .update(jobs)
      .set({ ownerWallet: onChain.owner.toLowerCase() })
      .where(and(eq(jobs.id, job.id), isNull(jobs.ownerWallet)));
    log.info("backfilled owner wallet", { jobId: job.id });
  }
}
