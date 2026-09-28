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
