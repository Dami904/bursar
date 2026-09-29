import { transitionDelta, type AuthorizationState } from "@bursar/policy";
import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "./client.js";
import { commitAlongLineage } from "./lineage.js";
import { appendAudit } from "./audit.js";
import { approvals, authorizations, categoryLimits, jobs } from "./schema.js";

/** A ledger rule was broken: a missing row, an illegal move, or a state that changed underneath. */
export class LedgerError extends Error {
  override readonly name = "LedgerError";
  constructor(
    readonly code: "NOT_FOUND" | "ILLEGAL_TRANSITION" | "STATE_CHANGED",
    message: string,
  ) {
    super(message);
  }
}

type AuthorizationRow = typeof authorizations.$inferSelect;

/** Fields a transition may set alongside the new state. Identity and amount never change. */
export type TransitionPatch = Partial<
  Omit<
    AuthorizationRow,
    | "id"
    | "state"
    | "decisionId"
    | "jobId"
    | "agentId"
    | "amount"
    | "category"
    | "createdAt"
    | "updatedAt"
  >
>;

export interface TransitionOptions {
  /** Compare-and-set: only move if the authorization is still in this state. */
  readonly expectFrom?: AuthorizationState;
}

const bigintParam = (value: bigint) => sql`${value.toString()}::bigint`;

/**
 * Moves an authorization to a new state and the job's counters with it, in one transaction.
 * Locks the job row first (the same order as requestSpend) so the two can't deadlock.
 */
export async function transition(
  db: Db,
  authorizationId: string,
  to: AuthorizationState,
  patch: TransitionPatch = {},
  options: TransitionOptions = {},
): Promise<AuthorizationRow> {
  return db.transaction(async (tx) => {
    const [peek] = await tx
      .select({ jobId: authorizations.jobId })
      .from(authorizations)
      .where(eq(authorizations.id, authorizationId));
    if (peek === undefined) throw new LedgerError("NOT_FOUND", "Authorization not found");
    await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, peek.jobId)).for("update");
    const [auth] = await tx
      .select()
      .from(authorizations)
      .where(eq(authorizations.id, authorizationId))
      .for("update");
    if (auth === undefined) throw new LedgerError("NOT_FOUND", "Authorization not found");
    if (options.expectFrom !== undefined && auth.state !== options.expectFrom) {
      throw new LedgerError(
        "STATE_CHANGED",
        `Expected ${options.expectFrom} but the authorization is ${auth.state}`,
      );
    }

    let delta;
    try {
      delta = transitionDelta(auth.state, to, auth.amount);
    } catch {
      throw new LedgerError(
        "ILLEGAL_TRANSITION",
        `Can't move an authorization from ${auth.state} to ${to}`,
      );
    }
    await applyJobDelta(tx, auth.jobId, delta);
    const drawn = gatewayDrawnDelta(auth.rail, auth.state, to, auth.amount);
    if (drawn !== 0n) {
      await tx
        .update(jobs)
        .set({ gatewayDrawn: sql`${jobs.gatewayDrawn} + ${bigintParam(drawn)}` })
        .where(eq(jobs.id, auth.jobId));
    }

    if (to === "RELEASED" || to === "REJECTED") {
      // The agent and every ancestor counted this amount; all of them get it back.
      await commitAlongLineage(tx, auth.agentId, -auth.amount);
      if (auth.category !== null) {
        await tx
          .update(categoryLimits)
          .set({ committed: sql`${categoryLimits.committed} - ${bigintParam(auth.amount)}` })
          .where(
            and(eq(categoryLimits.jobId, auth.jobId), eq(categoryLimits.category, auth.category)),
          );
      }
    }

    const [updated] = await tx
      .update(authorizations)
      .set({ ...patch, state: to, updatedAt: new Date() })
      .where(eq(authorizations.id, authorizationId))
      .returning();
    if (updated === undefined) throw new Error("authorization update returned nothing");
    // The approver's signed verdict, when this move answers an approval request.
    const [verdict] =
      auth.state === "PENDING_APPROVAL"
        ? await tx
            .select({
              verdict: approvals.verdict,
              approver: approvals.approverAddress,
              signature: approvals.signature,
              policyVersion: approvals.policyVersion,
            })
            .from(approvals)
            .where(eq(approvals.authorizationId, auth.id))
        : [];
    await appendAudit(tx, {
      jobId: auth.jobId,
      event: "transition",
      refId: auth.id,
      payload: {
        authorizationId: auth.id,
        decisionId: auth.decisionId,
        from: auth.state,
        to,
        amount: auth.amount,
        at: updated.updatedAt,
        vaultTx: updated.vaultTx,
        paymentTx: updated.paymentTx,
        refundTx: updated.refundTx,
        reason: updated.resolvedReason,
        approval: verdict ?? null,
      },
    });
    return updated;
  });
}

/** Updates bookkeeping fields (attempts, errors, payment details) without changing state. */
export async function annotate(
  db: Db | Tx,
  authorizationId: string,
  patch: TransitionPatch,
): Promise<void> {
  await db
    .update(authorizations)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(authorizations.id, authorizationId));
}

/** States in which a Gateway-rail payment has a claim on the job's Gateway balance. */
const DRAWING: readonly AuthorizationState[] = [
  "PENDING_APPROVAL",
  "RESERVED",
  "SIGNING",
  "UNRESOLVED",
  "SETTLED",
];

/**
 * How a move changes what Gateway-rail payments draw on the job's float: every live state holds
 * its amount against the float (so it's never counted twice against the budget); released or
 * rejected, it gives it back.
 */
export function gatewayDrawnDelta(
  rail: "VAULT" | "GATEWAY",
  from: AuthorizationState,
  to: AuthorizationState,
  amount: bigint,
): bigint {
  if (rail !== "GATEWAY") return 0n;
  const before = DRAWING.includes(from);
  const after = DRAWING.includes(to);
  return before === after ? 0n : after ? amount : -amount;
}

/**
 * What the job has committed: its payment buckets plus Gateway float that has left the vault but
 * isn't drawn on yet. The budget, the vault and Postgres's CHECK all hold this below the budget.
 */
export function committedOf(
  job: Pick<
    typeof jobs.$inferSelect,
    "settled" | "reserved" | "pending" | "unresolved" | "gatewayFunded" | "gatewayDrawn"
  >,
): bigint {
  const float = job.gatewayFunded - job.gatewayDrawn;
  return job.settled + job.reserved + job.pending + job.unresolved + (float > 0n ? float : 0n);
}

/** Unspent Gateway float: in the job's Gateway balance, not yet drawn on by a payment. */
export function gatewayFloatFree(
  job: Pick<typeof jobs.$inferSelect, "gatewayFunded" | "gatewayDrawn">,
): bigint {
  const float = job.gatewayFunded - job.gatewayDrawn;
  return float > 0n ? float : 0n;
}

async function applyJobDelta(
  tx: Tx,
  jobId: string,
  delta: { pending: bigint; reserved: bigint; unresolved: bigint; settled: bigint },
) {
  await tx
    .update(jobs)
    .set({
      pending: sql`${jobs.pending} + ${bigintParam(delta.pending)}`,
      reserved: sql`${jobs.reserved} + ${bigintParam(delta.reserved)}`,
      unresolved: sql`${jobs.unresolved} + ${bigintParam(delta.unresolved)}`,
      settled: sql`${jobs.settled} + ${bigintParam(delta.settled)}`,
    })
    .where(eq(jobs.id, jobId));
}
