import {
  annotate,
  approvals,
  authorizations,
  decisions,
  isInvoice,
  jobs,
  LedgerError,
  payoutAddress,
  transition,
  type Db,
} from "@bursar/db";
import {
  findGatewayTransfer,
  gatewayAvailable,
  jobVaultAbi,
  sendPayment,
  signPayment,
  usdcAbi,
  vaultOpIdFor,
  type WalletProvider,
} from "@bursar/payments";
import type { AuthorizationState } from "@bursar/policy";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { and, asc, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import {
  BaseError,
  ContractFunctionRevertedError,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { log, type Logger } from "./log.js";

export interface ExecutorDeps {
  readonly db: Db;
  readonly client: PublicClient;
  readonly operator: WalletClient<Transport, Chain, Account>;
  readonly vault: Hex;
  readonly usdc: Hex;
  readonly wallets: WalletProvider;
  /** CAIP-2 network, e.g. "eip155:5042002": where Gateway payments are checked. */
  readonly network: string;
  /** How long to wait for a release receipt before leaving it for the next tick. */
  readonly receiptTimeoutMs?: number;
}

const RECEIPT_TIMEOUT_MS = 30_000;
/** A broadcast release with no receipt after this long is re-sent (JobVault makes that safe). */
const RESEND_AFTER_MS = 60_000;
const RETRY_DELAY_MS = 10_000;
/** Gas limit for a replacement release: comfortably above release with an ERC-1271 approval. */
const REPLACEMENT_GAS = 500_000n;
const MAX_PAYMENT_ATTEMPTS = 3;
const NO_APPROVAL = {
  approver: "0x0000000000000000000000000000000000000000",
  deadline: 0n,
  signature: "0x",
} as const;

type AuthorizationRow = typeof authorizations.$inferSelect;
type JobRow = typeof jobs.$inferSelect;
type Step = "next" | "wait";

/** What the API stored at quote time; the worker pays exactly this and nothing else. */
export interface StoredPayment {
  readonly paymentRequired: PaymentRequired;
  readonly requirements: PaymentRequirements;
  /** The signed x402 header, kept so a retry resends the same payment (same nonce). */
  readonly signedHeader?: string;
}

const inFlight: AuthorizationState[] = ["RESERVED", "RELEASING", "FUNDED_WALLET", "SIGNING"];

/** Advances every purchase that's due. Returns how many it looked at. */
export async function executeOnce(deps: ExecutorDeps): Promise<number> {
  const now = new Date();
  const due = await deps.db
    .select()
    .from(authorizations)
    .where(
      and(
        inArray(authorizations.state, inFlight),
        // x402 purchases (a URL to pay) and invoices (an address the vault pays directly).
        or(isNotNull(authorizations.paymentUrl), isNotNull(authorizations.payTo)),
        or(isNull(authorizations.nextAttemptAt), lte(authorizations.nextAttemptAt, now)),
      ),
    )
    .orderBy(asc(authorizations.createdAt))
    .limit(10);

  for (const auth of due) {
    const logger = log.with({ authorizationId: auth.id, jobId: auth.jobId });
    try {
      await advance(deps, auth.id, logger);
    } catch (error) {
      // A step that throws learned nothing definitive: record it and retry later.
      logger.error("purchase step failed; will retry", error, { state: auth.state });
      await annotate(deps.db, auth.id, {
        attempts: auth.attempts + 1,
        lastError: error instanceof Error ? error.message.slice(0, 500) : String(error),
        nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS),
      });
    }
  }
  return due.length;
}

/** Runs consecutive steps for one purchase until it has to wait for the outside world. */
async function advance(deps: ExecutorDeps, id: string, logger: Logger): Promise<void> {
  for (let steps = 0; steps < 6; steps += 1) {
    const [auth] = await deps.db.select().from(authorizations).where(eq(authorizations.id, id));
    if (auth === undefined || !inFlight.includes(auth.state)) return;
    const [job] = await deps.db.select().from(jobs).where(eq(jobs.id, auth.jobId));
    if (job === undefined) return;
    let step: Step;
    try {
      switch (auth.state) {
        case "RESERVED":
          step =
            auth.rail === "GATEWAY"
              ? await signGateway(deps, auth, job, logger)
              : await startRelease(deps, auth);
          break;
        case "RELEASING":
          step = await settleRelease(deps, auth, job, logger);
          break;
        case "FUNDED_WALLET":
          step = await signAndPersist(deps, auth, job, logger);
          break;
        case "SIGNING":
          step =
            auth.rail === "GATEWAY"
              ? await payGateway(deps, auth, logger)
              : await pay(deps, auth, logger);
          break;
        default:
          return;
      }
    } catch (error) {
      // Another step moved it first: re-read and carry on from the new state.
      if (error instanceof LedgerError && error.code === "STATE_CHANGED") continue;
      throw error;
    }
    if (step === "wait") return;
  }
}

async function startRelease(deps: ExecutorDeps, auth: AuthorizationRow): Promise<Step> {
  await transition(
    deps.db,
    auth.id,
    "RELEASING",
    { vaultOpId: vaultOpIdFor(auth.id), attempts: 0, lastError: null },
    { expectFrom: "RESERVED" },
  );
  return "next";
}

/**
 * The vault paid out. For an invoice that WAS the payment (straight to the vendor): done. For a
 * purchase the money is now in the job wallet, which pays the seller next.
 */
async function releaseConfirmed(
  deps: ExecutorDeps,
  auth: AuthorizationRow,
  invoice: boolean,
  vaultTx: string | null,
): Promise<Step> {
  if (invoice) {
    await transition(
      deps.db,
      auth.id,
      "SETTLED",
      { paymentTx: vaultTx },
      { expectFrom: "RELEASING" },
    );
    return "wait";
  }
  await transition(deps.db, auth.id, "FUNDED_WALLET", {}, { expectFrom: "RELEASING" });
  return "next";
}

/**
 * Gets the job's money from the vault to where it goes: the job wallet, or the vendor directly. The chain is the source of truth:
 * releasedFor(job, op) > 0 means it happened, whatever we did or didn't hear back.
 */
async function settleRelease(
  deps: ExecutorDeps,
  auth: AuthorizationRow,
  job: JobRow,
  logger: Logger,
): Promise<Step> {
  const opId = (auth.vaultOpId ?? vaultOpIdFor(auth.id)) as Hex;
  const vaultJobId = job.vaultJobId as Hex | null;
  const invoice = isInvoice(auth);
  const to = payoutAddress(auth, job) as Hex | null;
  if (vaultJobId === null || to === null) {
    await transition(deps.db, auth.id, "RELEASED", {
      resolvedReason: "The job has no vault or wallet; nothing was paid",
    });
    return "wait";
  }

  const released = await deps.client.readContract({
    address: deps.vault,
    abi: jobVaultAbi,
    functionName: "releasedFor",
    args: [vaultJobId, opId],
  });
  if (released > 0n) {
    logger.info("vault release confirmed", { opId, vaultTx: auth.vaultTx, invoice });
    return releaseConfirmed(deps, auth, invoice, auth.vaultTx);
  }

  // A release already in flight: wait for it, and replace it only if it's been stuck a while.
  let replaceNonce: number | null = null;
  if (auth.vaultTx !== null) {
    const receipt = await deps.client
      .getTransactionReceipt({ hash: auth.vaultTx as Hex })
      .catch(() => null);
    const sentAt = (auth.vaultTxSentAt ?? auth.updatedAt).getTime();
    if (receipt === null && Date.now() - sentAt < RESEND_AFTER_MS) return "wait";
    // Not mined after a minute: replace it at the SAME nonce with higher fees. A new nonce would
    // queue behind the stuck one and never land first.
    if (receipt === null) replaceNonce = auth.vaultTxNonce;
  }

  const [decision] = await deps.db
    .select({ policyVersion: decisions.policyVersion })
    .from(decisions)
    .where(eq(decisions.id, auth.decisionId));
  const [approval] = await deps.db
    .select()
    .from(approvals)
    .where(and(eq(approvals.authorizationId, auth.id), eq(approvals.verdict, "APPROVED")));
  // With a human approval, cite the version the approver signed over; otherwise the decision's.
  const policyVersion = BigInt(
    approval?.policyVersion ?? decision?.policyVersion ?? job.policyVersion,
  );
  const approvalArg =
    approval?.approverAddress != null && approval.signature !== null && approval.deadline !== null
      ? {
          approver: approval.approverAddress as Hex,
          deadline: BigInt(Math.floor(approval.deadline.getTime() / 1000)),
          signature: approval.signature as Hex,
        }
      : NO_APPROVAL;
  const args = [vaultJobId, opId, to, auth.amount, policyVersion, approvalArg] as const;

  // Simulate first: a revert here is positive proof this release can't happen, before we spend gas.
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
    if (reason === null) throw error; // RPC trouble, not a verdict: retry later
    if (reason === "OpAlreadyUsed") return "next"; // it landed after all; releasedFor will say so
    await transition(
      deps.db,
      auth.id,
      "RELEASED",
      { resolvedReason: `The vault refused the release: ${reason}` },
      { expectFrom: "RELEASING" },
    );
    logger.warn("vault refused release", { opId, reason });
    return "wait";
  }

  let hash: Hex;
  let nonce: number;
  try {
    if (replaceNonce !== null) {
      const fees = await deps.client.estimateFeesPerGas();
      nonce = replaceNonce;
      hash = await deps.operator.writeContract({
        address: deps.vault,
        abi: jobVaultAbi,
        functionName: "release",
        args,
        nonce,
        // Explicit gas: estimating against the pending state would see the stuck release's own
        // effect and revert. JobVault's once-only operation id is the safety net either way.
        gas: REPLACEMENT_GAS,
        maxFeePerGas: (fees.maxFeePerGas * 3n) / 2n,
        maxPriorityFeePerGas: (fees.maxPriorityFeePerGas * 3n) / 2n,
      });
      logger.warn("replacing a stuck release at the same nonce with higher fees", {
        opId,
        nonce,
        replaced: auth.vaultTx,
      });
    } else {
      nonce = await deps.client.getTransactionCount({
        address: deps.operator.account.address,
        blockTag: "pending",
      });
      hash = await deps.operator.writeContract({
        address: deps.vault,
        abi: jobVaultAbi,
        functionName: "release",
        args,
        nonce,
      });
    }
  } catch (error) {
    // "nonce too low" / "already known": the earlier transaction landed or is still pending.
    // Either way releasedFor settles it on the next tick; never guess.
    logger.warn("release broadcast failed; will re-check the chain", {
      opId,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    });
    return "wait";
  }
  await annotate(deps.db, auth.id, {
    vaultTx: hash,
    vaultTxNonce: nonce,
    vaultTxSentAt: new Date(),
    attempts: auth.attempts + 1,
  });
  logger.info("vault release sent", { opId, vaultTx: hash, nonce });
  const receipt = await deps.client
    .waitForTransactionReceipt({ hash, timeout: deps.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS })
    .catch(() => null);
  if (receipt?.status === "success") return releaseConfirmed(deps, auth, invoice, hash);
  // Reverted or unknown: the next tick reads releasedFor and, if needed, simulates for the reason.
  return "wait";
}

/** Signs the x402 payment with the job's wallet and saves payer, nonce and expiry BEFORE paying. */
async function signAndPersist(
  deps: ExecutorDeps,
  auth: AuthorizationRow,
  job: JobRow,
  logger: Logger,
): Promise<Step> {
  const stored = auth.paymentRequirements as StoredPayment | null;
  if (stored === null || job.agentWalletId === null || job.agentWalletAddress === null) {
    throw new Error("Purchase is missing its quote or the job has no wallet");
  }
  // Pay exactly what was reserved, to exactly who was quoted. Anything else is a bug: stop.
  if (BigInt(stored.requirements.amount) !== auth.amount) {
    throw new Error("Quoted amount no longer matches the reserved amount");
  }
  const signer = deps.wallets.signer({
    id: job.agentWalletId,
    address: job.agentWalletAddress as Hex,
  });
  const signed = await signPayment(signer, stored.paymentRequired, stored.requirements);
  await transition(
    deps.db,
    auth.id,
    "SIGNING",
    {
      payer: signed.payer,
      payTo: stored.requirements.payTo,
      paymentNonce: signed.nonce,
      validBefore: signed.validBefore,
      paymentRequirements: { ...stored, signedHeader: signed.header },
      attempts: 0,
    },
    { expectFrom: "FUNDED_WALLET" },
  );
  logger.info("x402 payment signed", { payer: signed.payer, nonce: signed.nonce });
  return "next";
}

/** Sends the saved payment and confirms it on-chain by nonce. */
async function pay(deps: ExecutorDeps, auth: AuthorizationRow, logger: Logger): Promise<Step> {
  const stored = auth.paymentRequirements as StoredPayment | null;
  if (
    stored?.signedHeader === undefined ||
    auth.payer === null ||
    auth.paymentNonce === null ||
    auth.validBefore === null ||
    auth.paymentUrl === null
  ) {
    throw new Error("SIGNING without a saved payment");
  }

  if (await nonceUsed(deps, auth)) {
    await transition(
      deps.db,
      auth.id,
      "SETTLED",
      { resolvedReason: "Settlement confirmed on-chain by nonce" },
      { expectFrom: "SIGNING" },
    );
    return "wait";
  }
  if (Date.now() >= auth.validBefore.getTime()) {
    await unresolved(deps, auth, "The signed payment expired unused; USDC is in the job wallet");
    return "wait";
  }

  const outcome = await sendPayment(auth.paymentUrl, stored.signedHeader);
  switch (outcome.kind) {
    case "PAID": {
      // Trust, then verify: the seller's receipt is confirmed against USDC itself.
      for (let i = 0; i < 5 && !(await nonceUsed(deps, auth)); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (await nonceUsed(deps, auth)) {
        await transition(
          deps.db,
          auth.id,
          "SETTLED",
          { paymentTx: outcome.settlement.transaction, deliverable: outcome.body },
          { expectFrom: "SIGNING" },
        );
        logger.info("purchase settled", { paymentTx: outcome.settlement.transaction });
      } else {
        await annotate(deps.db, auth.id, {
          deliverable: outcome.body,
          paymentTx: outcome.settlement.transaction,
          nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS),
        });
        logger.warn("seller reports payment but USDC hasn't confirmed the nonce yet", {
          paymentTx: outcome.settlement.transaction,
        });
      }
      return "wait";
    }
    case "REFUSED":
      await unresolved(
        deps,
        auth,
        `The seller refused the payment (HTTP ${outcome.status}); USDC is in the job wallet`,
      );
      logger.warn("seller refused payment", {
        status: outcome.status,
        body: outcome.body.slice(0, 300),
      });
      return "wait";
    case "UNKNOWN": {
      const attempts = auth.attempts + 1;
      logger.warn("payment outcome unknown", { reason: outcome.reason, attempts });
      if (attempts >= MAX_PAYMENT_ATTEMPTS) {
        await unresolved(deps, auth, `No answer from the seller after ${attempts} tries`);
      } else {
        await annotate(deps.db, auth.id, {
          attempts,
          lastError: outcome.reason,
          nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS),
        });
      }
      return "wait";
    }
  }
}

/** How long a Gateway payment waits for the job's Gateway balance before it's given up. */
const GATEWAY_FUNDING_LIMIT_MS = 15 * 60_000;

/**
 * Gateway rail: no vault release per payment. Once the job's Gateway balance covers it (the float
 * manager tops it up), sign the batched payment with the job wallet and save it before sending.
 */
async function signGateway(
  deps: ExecutorDeps,
  auth: AuthorizationRow,
  job: JobRow,
  logger: Logger,
): Promise<Step> {
  const stored = auth.paymentRequirements as StoredPayment | null;
  if (stored === null || job.agentWalletId === null || job.agentWalletAddress === null) {
    throw new Error("Gateway payment is missing its quote or the job has no wallet");
  }
  if (BigInt(stored.requirements.amount) !== auth.amount) {
    throw new Error("Quoted amount no longer matches the reserved amount");
  }
  const available = await gatewayAvailable(deps.network, job.agentWalletAddress);
  if (available < auth.amount) {
    if (Date.now() - auth.createdAt.getTime() > GATEWAY_FUNDING_LIMIT_MS) {
      await transition(
        deps.db,
        auth.id,
        "RELEASED",
        { resolvedReason: "The job's Gateway balance didn't arrive in time; nothing was paid" },
        { expectFrom: "RESERVED" },
      );
      logger.warn("gateway payment released: no balance in time");
      return "wait";
    }
    await annotate(deps.db, auth.id, {
      lastError: "Waiting for the job's Gateway balance",
      nextAttemptAt: new Date(Date.now() + 5_000),
    });
    return "wait";
  }
  const signer = deps.wallets.signer({
    id: job.agentWalletId,
    address: job.agentWalletAddress as Hex,
  });
  const signed = await signPayment(signer, stored.paymentRequired, stored.requirements);
  await transition(
    deps.db,
    auth.id,
    "SIGNING",
    {
      payer: signed.payer,
      payTo: stored.requirements.payTo,
      paymentNonce: signed.nonce,
      validBefore: signed.validBefore,
      paymentRequirements: { ...stored, signedHeader: signed.header },
      attempts: 0,
      lastError: null,
    },
    { expectFrom: "RESERVED" },
  );
  logger.info("gateway payment signed", { payer: signed.payer, nonce: signed.nonce });
  return "next";
}

/**
 * Sends a signed Gateway payment. Circle Gateway is the source of truth: a payment is paid when
 * Gateway has received it (Circle settles it on-chain later, in a batch).
 */
async function payGateway(
  deps: ExecutorDeps,
  auth: AuthorizationRow,
  logger: Logger,
): Promise<Step> {
  const stored = auth.paymentRequirements as StoredPayment | null;
  if (
    stored?.signedHeader === undefined ||
    auth.payer === null ||
    auth.paymentNonce === null ||
    auth.paymentUrl === null
  ) {
    throw new Error("SIGNING without a saved Gateway payment");
  }
  // Sent before a crash? Then it's paid, and sending it again would only be refused.
  const earlier = await findGatewayTransfer(deps.network, auth.payer, auth.paymentNonce);
  if (earlier !== null) {
    await transition(
      deps.db,
      auth.id,
      "SETTLED",
      { gatewayTransferId: earlier.id, resolvedReason: "Circle Gateway had already received it" },
      { expectFrom: "SIGNING" },
    );
    return "wait";
  }

  const outcome = await sendPayment(auth.paymentUrl, stored.signedHeader);
  switch (outcome.kind) {
    case "PAID": {
      // Trust, then verify: the seller's receipt is confirmed with Circle Gateway itself.
      let transfer = null;
      for (let i = 0; i < 5 && transfer === null; i += 1) {
        transfer = await findGatewayTransfer(deps.network, auth.payer, auth.paymentNonce);
        if (transfer === null) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (transfer !== null) {
        await transition(
          deps.db,
          auth.id,
          "SETTLED",
          { gatewayTransferId: transfer.id, deliverable: outcome.body },
          { expectFrom: "SIGNING" },
        );
        logger.info("gateway payment settled", { transferId: transfer.id });
      } else {
        await annotate(deps.db, auth.id, {
          deliverable: outcome.body,
          nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS),
        });
        logger.warn("seller reports a Gateway payment that Gateway doesn't show yet", {
          reported: outcome.settlement.transaction,
        });
      }
      return "wait";
    }
    case "REFUSED":
      // Gateway never received it. The float was counted against the budget in full, so even if
      // this signature were used later it couldn't spend past the budget: release it now.
      await transition(
        deps.db,
        auth.id,
        "RELEASED",
        {
          resolvedReason: `The seller refused the Gateway payment (HTTP ${outcome.status}); nothing was paid`,
        },
        { expectFrom: "SIGNING" },
      );
      logger.warn("seller refused gateway payment", {
        status: outcome.status,
        body: outcome.body.slice(0, 300),
      });
      return "wait";
    case "UNKNOWN": {
      const attempts = auth.attempts + 1;
      logger.warn("gateway payment outcome unknown", { reason: outcome.reason, attempts });
      if (attempts >= MAX_PAYMENT_ATTEMPTS) {
        await unresolved(deps, auth, `No answer from the seller after ${attempts} tries`);
      } else {
        await annotate(deps.db, auth.id, {
          attempts,
          lastError: outcome.reason,
          nextAttemptAt: new Date(Date.now() + RETRY_DELAY_MS),
        });
      }
      return "wait";
    }
  }
}

async function nonceUsed(deps: ExecutorDeps, auth: AuthorizationRow): Promise<boolean> {
  return deps.client.readContract({
    address: deps.usdc,
    abi: usdcAbi,
    functionName: "authorizationState",
    args: [auth.payer as Hex, auth.paymentNonce as Hex],
  });
}

/** Keeps the money counted until the reconciler (day 6) proves where it is and refunds it. */
async function unresolved(deps: ExecutorDeps, auth: AuthorizationRow, reason: string) {
  await transition(
    deps.db,
    auth.id,
    "UNRESOLVED",
    { resolvedReason: reason },
    { expectFrom: "SIGNING" },
  );
}

/** The custom error a contract call reverted with, or null if it failed for another reason. */
export function revertReason(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) {
    return reverted.data?.errorName ?? reverted.reason ?? "reverted";
  }
  return null;
}
