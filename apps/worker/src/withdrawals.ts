import { authorizations, gatewayFloats, gatewayWithdrawals, jobs, type Db } from "@bursar/db";
import {
  BurnIntentUsedError,
  burnIntentTypedData,
  gatewayAvailable,
  gatewayMinterAbi,
  gatewayTransferStatus,
  GATEWAY_NETWORKS,
  gatewayWithdrawIntent,
  submitBurnIntent,
  type BurnIntent,
  type WalletProvider,
} from "@bursar/payments";
import { and, asc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import {
  keccak256,
  toHex,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { revertReason } from "./executor.js";
import { errorText, log, type Logger } from "./log.js";

/**
 * Gives a closed job's unspent Gateway float back to its owner.
 *
 * Closing the vault returns what's left in it, but a float already moved into Circle Gateway sits
 * under the job wallet. Once nothing can draw on it any more, the job wallet signs a burn intent
 * for the balance (less Circle's fee), Circle attests it, and the operator submits the mint, which
 * pays the USDC straight to the wallet that owns the job on-chain.
 *
 * Crash safety: the signed intent is saved before Circle sees it, and Circle's attestation the
 * moment it's returned. Circle refuses the same intent twice and the minter refuses the same
 * attestation twice, so nothing can pay out twice. If an attestation is ever lost, Circle never
 * burns the balance (it burns only once it sees the mint): the attestation expires, the balance
 * comes back, and a new withdrawal picks it up.
 */

export interface WithdrawDeps {
  readonly db: Db;
  readonly client: PublicClient;
  readonly operator: WalletClient<Transport, Chain, Account>;
  readonly usdc: Hex;
  readonly wallets: WalletProvider;
  readonly network: string;
  /** How often closed jobs are checked for a balance to return. */
  readonly scanIntervalMs?: number;
}

type WithdrawalRow = typeof gatewayWithdrawals.$inferSelect;

const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const RETRY_MS = 15_000;
const MAX_SUBMIT_ATTEMPTS = 10;
const OPEN: WithdrawalRow["state"][] = ["SUBMITTING", "ATTESTED"];
/** Gateway payments that still draw on the float. */
const DRAWING = ["PENDING_APPROVAL", "RESERVED", "SIGNING", "UNRESOLVED"] as const;
const FLOAT_BUSY = ["RELEASING", "FUNDED", "DEPOSITING", "CREDITING"] as const;

let lastScanAt = 0;

export async function withdrawOnce(deps: WithdrawDeps): Promise<void> {
  if (GATEWAY_NETWORKS[deps.network] === undefined) return;
  const interval = deps.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
  if (Date.now() - lastScanAt >= interval) {
    lastScanAt = Date.now();
    await startWithdrawals(deps);
  }
  const open = await deps.db
    .select()
    .from(gatewayWithdrawals)
    .where(inArray(gatewayWithdrawals.state, OPEN))
    .orderBy(asc(gatewayWithdrawals.createdAt))
    .limit(10);
  for (const row of open) {
    if (row.nextAttemptAt !== null && row.nextAttemptAt.getTime() > Date.now()) continue;
    const logger = log.with({ jobId: row.jobId, withdrawalId: row.id, step: "gateway-withdraw" });
    try {
      await advance(deps, row, logger);
    } catch (error) {
      logger.error("gateway withdrawal step failed; will retry", error, { state: row.state });
      await setRow(deps, row.id, {
        attempts: row.attempts + 1,
        lastError: errorText(error),
        nextAttemptAt: new Date(Date.now() + RETRY_MS),
      });
    }
  }
}

/** Resets the scan timer (tests run scans back to back). */
export function resetWithdrawScan(): void {
  lastScanAt = 0;
}

async function startWithdrawals(deps: WithdrawDeps) {
  const closed = await deps.db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "CLOSED"),
        gt(jobs.gatewayFunded, jobs.gatewayDrawn),
        isNotNull(jobs.ownerWallet),
        isNotNull(jobs.agentWalletId),
      ),
    );
  for (const job of closed) {
    const logger = log.with({ jobId: job.id, step: "gateway-withdraw" });
    try {
      if (!(await idle(deps, job.id))) continue;
      const wallet = { id: job.agentWalletId as string, address: job.agentWalletAddress as Hex };
      const available = await gatewayAvailable(deps.network, wallet.address);
      const id = crypto.randomUUID();
      const intent =
        available === 0n
          ? null
          : await gatewayWithdrawIntent(deps.network, {
              usdc: deps.usdc,
              depositor: wallet.address,
              recipient: job.ownerWallet as Hex,
              available,
              salt: keccak256(toHex(`bursar:gateway-withdraw:${id}`)),
            });
      if (intent === null) {
        // Nothing left worth Circle's fee: close the float out so the job stops being checked.
        await deps.db
          .update(jobs)
          .set({ gatewayFunded: jobs.gatewayDrawn })
          .where(eq(jobs.id, job.id));
        logger.info("closed job's Gateway balance is below Circle's fee; nothing to return", {
          available,
        });
        continue;
      }
      const signature = await deps.wallets
        .signer(wallet)
        .signTypedData(
          burnIntentTypedData(intent) as unknown as Parameters<
            ReturnType<WalletProvider["signer"]>["signTypedData"]
          >[0],
        );
      await deps.db.insert(gatewayWithdrawals).values({
        id,
        jobId: job.id,
        amount: intent.spec.value,
        recipient: job.ownerWallet as string,
        burnIntent: toJson(intent),
        intentSignature: signature,
      });
      logger.info("returning closed job's Gateway balance to its owner", {
        withdrawalId: id,
        amount: intent.spec.value,
        maxFee: intent.maxFee,
      });
    } catch (error) {
      logger.error("couldn't start a gateway withdrawal; will retry", error);
    }
  }
}

/** True when nothing can draw on the job's Gateway balance and no withdrawal is under way. */
async function idle(deps: WithdrawDeps, jobId: string): Promise<boolean> {
  const [paying] = await deps.db
    .select({ id: authorizations.id })
    .from(authorizations)
    .where(
      and(
        eq(authorizations.jobId, jobId),
        eq(authorizations.rail, "GATEWAY"),
        inArray(authorizations.state, [...DRAWING]),
      ),
    )
    .limit(1);
  if (paying !== undefined) return false;
  const [floating] = await deps.db
    .select({ id: gatewayFloats.id })
    .from(gatewayFloats)
    .where(and(eq(gatewayFloats.jobId, jobId), inArray(gatewayFloats.state, [...FLOAT_BUSY])))
    .limit(1);
  if (floating !== undefined) return false;
  const [withdrawing] = await deps.db
    .select({ id: gatewayWithdrawals.id })
    .from(gatewayWithdrawals)
    .where(and(eq(gatewayWithdrawals.jobId, jobId), inArray(gatewayWithdrawals.state, OPEN)))
    .limit(1);
  return withdrawing === undefined;
}

async function advance(deps: WithdrawDeps, row: WithdrawalRow, logger: Logger) {
  switch (row.state) {
    case "SUBMITTING": {
      try {
        const attested = await submitBurnIntent(
          deps.network,
          fromJson(row.burnIntent),
          row.intentSignature as Hex,
        );
        await setRow(deps, row.id, {
          state: "ATTESTED",
          transferId: attested.transferId,
          attestation: attested.attestation,
          attestationSignature: attested.signature,
          fee: attested.fee,
          attempts: 0,
          lastError: null,
          nextAttemptAt: null,
        });
        logger.info("Circle attested the gateway withdrawal", {
          transferId: attested.transferId,
          fee: attested.fee,
        });
      } catch (error) {
        if (error instanceof BurnIntentUsedError) {
          // Attested before a crash, but the attestation wasn't saved. Circle burns nothing
          // until it sees a mint, so the balance comes back when the attestation expires.
          await fail(
            deps,
            row,
            "Circle had already attested this withdrawal but its attestation wasn't saved; the balance returns when it expires, and a new withdrawal follows",
            logger,
          );
          return;
        }
        if (row.attempts + 1 >= MAX_SUBMIT_ATTEMPTS) {
          // Never attested, so nothing moved: a fresh withdrawal starts on the next scan.
          await fail(deps, row, `Circle didn't attest it: ${(error as Error).message}`, logger);
          return;
        }
        throw error;
      }
      return;
    }

    case "ATTESTED": {
      if (row.mintTx !== null) {
        const receipt = await deps.client
          .getTransactionReceipt({ hash: row.mintTx as Hex })
          .catch(() => null);
        if (receipt === null) return; // still pending
        if (receipt.status === "success") {
          await done(deps, row, row.mintTx, logger);
          return;
        }
        await setRow(deps, row.id, { mintTx: null, lastError: "The mint transaction reverted" });
        return;
      }
      if (row.transferId !== null) {
        const status = await gatewayTransferStatus(deps.network, row.transferId);
        if (status.status === "finalized" && status.transactionHash !== null) {
          await done(deps, row, status.transactionHash, logger);
          return;
        }
      }
      const args = [row.attestation as Hex, row.attestationSignature as Hex] as const;
      const minter = GATEWAY_NETWORKS[deps.network]?.gatewayMinter;
      if (minter === undefined) throw new Error(`No Gateway minter for ${deps.network}`);
      try {
        await deps.client.simulateContract({
          address: minter,
          abi: gatewayMinterAbi,
          functionName: "gatewayMint",
          args,
          account: deps.operator.account,
        });
      } catch (error) {
        if (revertReason(error) === null && !/revert/i.test((error as Error).message)) throw error;
        // Already minted (Circle's status will say so shortly) or expired: check again later.
        await setRow(deps, row.id, {
          attempts: row.attempts + 1,
          lastError: "The minter refused the attestation (already minted, or expired)",
          nextAttemptAt: new Date(Date.now() + RETRY_MS),
        });
        if (row.attempts + 1 >= MAX_SUBMIT_ATTEMPTS) {
          await fail(deps, row, "The minter refused the attestation", logger);
        }
        return;
      }
      const hash = await deps.operator.writeContract({
        address: minter,
        abi: gatewayMinterAbi,
        functionName: "gatewayMint",
        args,
      });
      await setRow(deps, row.id, { mintTx: hash });
      logger.info("gateway withdrawal mint sent", { mintTx: hash });
      const receipt = await deps.client
        .waitForTransactionReceipt({ hash, timeout: 30_000 })
        .catch(() => null);
      if (receipt?.status === "success") await done(deps, row, hash, logger);
      return;
    }

    default:
      return;
  }
}

/** Minted: the owner has the USDC. The float is closed out on the job's ledger. */
async function done(deps: WithdrawDeps, row: WithdrawalRow, mintTx: string, logger: Logger) {
  const spent = row.amount + (row.fee ?? 0n);
  await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(gatewayWithdrawals)
      .set({ state: "DONE", mintTx, updatedAt: new Date() })
      .where(and(eq(gatewayWithdrawals.id, row.id), eq(gatewayWithdrawals.state, "ATTESTED")))
      .returning({ id: gatewayWithdrawals.id });
    if (updated === undefined) return; // another tick got here first
    await tx
      .update(jobs)
      .set({
        gatewayFunded: sql`${jobs.gatewayFunded} - least(${spent.toString()}::bigint, greatest(${jobs.gatewayFunded} - ${jobs.gatewayDrawn}, 0))`,
        gatewayReturned: sql`${jobs.gatewayReturned} + ${row.amount.toString()}::bigint`,
      })
      .where(eq(jobs.id, row.jobId));
  });
  logger.info("closed job's Gateway balance returned to its owner", {
    amount: row.amount,
    fee: row.fee,
    recipient: row.recipient,
    mintTx,
  });
}

async function fail(deps: WithdrawDeps, row: WithdrawalRow, reason: string, logger: Logger) {
  await setRow(deps, row.id, { state: "FAILED", lastError: reason });
  logger.warn("gateway withdrawal given up; a new one follows if the balance is still there", {
    reason,
  });
}

async function setRow(deps: WithdrawDeps, id: string, patch: Partial<WithdrawalRow>) {
  await deps.db
    .update(gatewayWithdrawals)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(gatewayWithdrawals.id, id));
}

function toJson(intent: BurnIntent): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(intent, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  ) as Record<string, unknown>;
}

function fromJson(stored: unknown): BurnIntent {
  const raw = stored as {
    maxBlockHeight: string;
    maxFee: string;
    spec: Record<string, unknown> & { value: string };
  };
  return {
    maxBlockHeight: BigInt(raw.maxBlockHeight),
    maxFee: BigInt(raw.maxFee),
    spec: { ...(raw.spec as unknown as BurnIntent["spec"]), value: BigInt(raw.spec.value) },
  };
}
