import { formatUsdc } from "@bursar/money";
import {
  approvals,
  approvers,
  authorizations,
  credentials,
  decisions,
  jobs,
  payoutAddress,
  transition,
  type Db,
} from "@bursar/db";
import { approvalTypedData, vaultOpIdFor } from "@bursar/payments";
import { and, desc, eq, inArray } from "drizzle-orm";
import { verifyTypedData, type Hex } from "viem";
import { issueKey } from "../auth/keys.js";
import { badRequest, conflict, forbidden, notFound } from "../http/errors.js";

export interface ChainConfig {
  readonly chainId: number;
  readonly vault: Hex;
}

/** Signatures may be valid for at most this long; JobVault also checks the deadline. */
const MAX_APPROVAL_LIFETIME_S = 24 * 60 * 60;

export async function createApprover(db: Db, ownerId: string, name: string, walletAddress: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress))
    throw badRequest("walletAddress must be a 0x address");
  const issued = issueKey("APPROVER");
  return db.transaction(async (tx) => {
    const [approver] = await tx
      .insert(approvers)
      .values({ ownerId, name, walletAddress: walletAddress.toLowerCase() })
      .onConflictDoNothing()
      .returning();
    if (approver === undefined)
      throw conflict("APPROVER_EXISTS", "That wallet is already an approver");
    await tx.insert(credentials).values({
      keyHash: issued.hash,
      keyPrefix: issued.prefix,
      role: "APPROVER",
      ownerId,
      approverId: approver.id,
    });
    return { approver, key: issued.key };
  });
}

/** Payments waiting for a human, each with the exact message the approver's wallet must sign. */
export async function listPending(db: Db, ownerId: string, chain: ChainConfig, deadlineIn = 3600) {
  const rows = await db
    .select({ auth: authorizations, job: jobs, decision: decisions })
    .from(authorizations)
    .innerJoin(jobs, eq(jobs.id, authorizations.jobId))
    .innerJoin(decisions, eq(decisions.id, authorizations.decisionId))
    .where(and(eq(jobs.ownerId, ownerId), eq(authorizations.state, "PENDING_APPROVAL")))
    .orderBy(desc(authorizations.createdAt))
    .limit(50);
  const deadline = Math.floor(Date.now() / 1000) + deadlineIn;
  return rows.map(({ auth, job, decision }) => ({
    authorizationId: auth.id,
    jobId: job.id,
    jobTitle: job.title,
    amount: formatUsdc(auth.amount),
    payee: decision.payee,
    reasoning: decision.reasoning,
    requestedAt: auth.createdAt.toISOString(),
    typedData:
      job.vaultJobId === null || payoutAddress(auth, job) === null
        ? null
        : serializable(
            approvalTypedData({
              chainId: chain.chainId,
              vault: chain.vault,
              vaultJobId: job.vaultJobId as Hex,
              opId: vaultOpIdFor(auth.id),
              to: payoutAddress(auth, job) as Hex,
              amount: auth.amount,
              policyVersion: job.policyVersion,
              deadline,
            }),
          ),
  }));
}

export interface ApproveInput {
  readonly approverAddress: string;
  readonly signature: string;
  /** Unix seconds, as signed. */
  readonly deadline: number;
  readonly policyVersion: number;
}

/**
 * Records a human approval. The signature is checked here against the exact message JobVault
 * will check, and the signer must be one of the owner's approvers, so a bad approval fails now
 * instead of at release time. The worker then passes it to `release` unchanged.
 */
export async function approve(
  db: Db,
  ownerId: string,
  authorizationId: string,
  input: ApproveInput,
  chain: ChainConfig,
) {
  const { auth, job } = await loadPending(db, ownerId, authorizationId);
  const address = input.approverAddress.toLowerCase();
  const [approver] = await db
    .select()
    .from(approvers)
    .where(and(eq(approvers.ownerId, ownerId), eq(approvers.walletAddress, address)));
  if (approver === undefined) throw forbidden("wallet that isn't one of your approvers");

  const now = Math.floor(Date.now() / 1000);
  if (input.deadline <= now || input.deadline > now + MAX_APPROVAL_LIFETIME_S) {
    throw badRequest("deadline must be in the future and within 24 hours");
  }
  if (input.policyVersion !== job.policyVersion) {
    throw conflict("STALE_POLICY", "The job's rules changed; fetch the approval message again");
  }
  const to = payoutAddress(auth, job);
  if (job.vaultJobId === null || to === null) {
    throw conflict("NOT_ON_CHAIN", "The job isn't live on-chain yet");
  }
  const typed = approvalTypedData({
    chainId: chain.chainId,
    vault: chain.vault,
    vaultJobId: job.vaultJobId as Hex,
    opId: vaultOpIdFor(auth.id),
    // The approver signs over the real recipient: the vendor for an invoice, else the job wallet.
    to: to as Hex,
    amount: auth.amount,
    policyVersion: input.policyVersion,
    deadline: input.deadline,
  });
  const valid = await verifyTypedData({
    address: address as Hex,
    ...typed,
    signature: input.signature as Hex,
  }).catch(() => false);
  if (!valid) throw badRequest("The signature doesn't match this approval");

  await db.insert(approvals).values({
    authorizationId,
    approverId: approver.id,
    verdict: "APPROVED",
    approverAddress: address,
    signature: input.signature,
    deadline: new Date(input.deadline * 1000),
    policyVersion: input.policyVersion,
  });
  return transition(db, authorizationId, "RESERVED", {}, { expectFrom: "PENDING_APPROVAL" });
}

export async function reject(
  db: Db,
  ownerId: string,
  authorizationId: string,
  note: string | undefined,
) {
  await loadPending(db, ownerId, authorizationId);
  await db
    .insert(approvals)
    .values({ authorizationId, verdict: "REJECTED", note: note ?? null })
    .onConflictDoNothing();
  return transition(
    db,
    authorizationId,
    "REJECTED",
    { resolvedReason: note === undefined ? "Rejected by an approver" : `Rejected: ${note}` },
    { expectFrom: "PENDING_APPROVAL" },
  );
}

async function loadPending(db: Db, ownerId: string, authorizationId: string) {
  const [row] = await db
    .select({ auth: authorizations, job: jobs })
    .from(authorizations)
    .innerJoin(jobs, eq(jobs.id, authorizations.jobId))
    .where(and(eq(authorizations.id, authorizationId), eq(jobs.ownerId, ownerId)));
  if (row === undefined) throw notFound("Approval request");
  if (row.auth.state !== "PENDING_APPROVAL") {
    throw conflict("NOT_PENDING", `This payment is ${row.auth.state}, not waiting for approval`);
  }
  const [decided] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(inArray(approvals.authorizationId, [authorizationId]));
  if (decided !== undefined)
    throw conflict("ALREADY_DECIDED", "This payment already has a verdict");
  return row;
}

/** EIP-712 messages carry bigints; JSON can't. */
function serializable<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
  );
}
