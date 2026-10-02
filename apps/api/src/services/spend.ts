import {
  currentWindow,
  evaluatePolicy,
  type AuthorizationState,
  type PolicyOutcome,
} from "@bursar/policy";
import { and, eq, sql } from "drizzle-orm";
import type { AgentPrincipal } from "../auth/principal.js";
import type { Db } from "@bursar/db";
import {
  agents,
  appendAudit,
  authorizations,
  categoryLimits,
  commitAlongLineage,
  committedOf,
  decisionPayload,
  requestHashOf,
  storedRequestOf,
  decisions,
  gatewayFloatFree,
  jobs,
  lineage,
  payees,
} from "@bursar/db";
import { conflict, notFound } from "../http/errors.js";
import { normalizePayee, type PayeeKind } from "./payees.js";

export interface SpendInput {
  /** Chosen by the agent; a retry with the same ID returns the original decision. */
  readonly operationId: string;
  readonly kind: "PURCHASE" | "INVOICE";
  readonly payee: { readonly kind: PayeeKind; readonly value: string };
  readonly amount: bigint;
  /** Why the agent wants this. Stored beside the policy result as evidence. */
  readonly reasoning: string;
  /**
   * For x402 purchases: the resource and the seller's quoted requirements. Stored with the
   * reservation in the same transaction, so the worker only ever pays exactly what was decided.
   */
  readonly payment?: { readonly url: string; readonly quote: unknown } | undefined;
  /** For invoices: the vendor's reference (invoice number). */
  readonly invoiceRef?: string | undefined;
  /** For purchases: the exact URL asked for. */
  readonly resourceUrl?: string | undefined;
  /**
   * When the payee isn't on the allow-list by name but through an entry like a marketplace: that
   * entry's rules (its category) apply, and the decision records how it was allowed.
   */
  readonly allowedBy?:
    { readonly kind: PayeeKind; readonly value: string; readonly source: string } | undefined;
  /** GATEWAY: a sub-cent payment from the job's Gateway balance. Default VAULT. */
  readonly rail?: "VAULT" | "GATEWAY" | undefined;
}

type DecisionRow = typeof decisions.$inferSelect;
type AuthorizationRow = typeof authorizations.$inferSelect;

export interface SpendResult {
  /** True when this operation ID was already decided and the stored decision was returned. */
  readonly replayed: boolean;
  readonly decision: DecisionRow;
  readonly authorization: AuthorizationRow | null;
}

const bigintParam = (value: bigint) => sql`${value.toString()}::bigint`;

export { committedOf } from "@bursar/db";

/**
 * Decides a spend request and, if allowed, reserves the money, all in one transaction.
 *
 * Every spend on a job starts by locking that job's row, so concurrent requests are decided one at
 * a time against up-to-date counters: parallel agents can't collectively overspend. The pure policy
 * engine gives the reason; the jobs_budget_invariant CHECK constraint is the backstop.
 */
export async function requestSpend(
  db: Db,
  principal: AgentPrincipal,
  input: SpendInput,
  now: Date = new Date(),
): Promise<SpendResult> {
  const payeeValue = normalizePayee(input.payee.kind, input.payee.value);

  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, principal.jobId)).for("update");
    if (job === undefined) throw notFound("Job");

    const [existing] = await tx
      .select()
      .from(decisions)
      .where(and(eq(decisions.jobId, job.id), eq(decisions.operationId, input.operationId)));
    if (existing !== undefined) {
      if (existing.agentId !== principal.agentId) {
        throw conflict("OPERATION_ID_IN_USE", "This operation ID belongs to another agent");
      }
      const [authorization] = await tx
        .select()
        .from(authorizations)
        .where(eq(authorizations.decisionId, existing.id));
      return { replayed: true, decision: existing, authorization: authorization ?? null };
    }

    const [agent] = await tx.select().from(agents).where(eq(agents.id, principal.agentId));
    // [self, parent, …]: this agent's spending counts against every limit up the tree.
    const chain = agent === undefined ? [] : await lineage(tx, agent.id);
    const ancestors = chain.slice(1);
    const [payee] = await tx
      .select()
      .from(payees)
      .where(
        input.allowedBy === undefined
          ? and(
              eq(payees.jobId, job.id),
              eq(payees.kind, input.payee.kind),
              eq(payees.value, payeeValue),
            )
          : and(
              eq(payees.jobId, job.id),
              eq(payees.kind, input.allowedBy.kind),
              eq(payees.value, input.allowedBy.value),
            ),
      );
    // The category comes from the owner's allow-list entry, never from the agent's request.
    const category = payee?.category ?? null;
    const [limit] =
      category === null
        ? []
        : await tx
            .select()
            .from(categoryLimits)
            .where(and(eq(categoryLimits.jobId, job.id), eq(categoryLimits.category, category)));

    const committed = committedOf(job);
    const rail = input.rail ?? "VAULT";
    // A Gateway payment the unspent float already covers moves money from "float" to "payment";
    // only the part the float doesn't cover is new spending against the budget.
    const covered =
      rail === "GATEWAY"
        ? (() => {
            const free = gatewayFloatFree(job);
            return free < input.amount ? free : input.amount;
          })()
        : 0n;
    const outcome: PolicyOutcome = evaluatePolicy({
      job: {
        id: job.id,
        // A frozen job spends nothing until the owner has looked at the unexplained payout.
        status: job.frozenReason === null ? job.status : "PAUSED",
        expiresAt: job.expiresAt,
        budget: job.budget,
        deposited: job.deposited,
        committed: committed - covered,
        perTxCap: job.perTxCap,
        approvalThreshold: job.approvalThreshold,
        windowCap: job.windowCap,
        windowSeconds: job.windowSeconds,
        windowStart: job.windowStart,
        windowSpent: job.windowSpent,
      },
      agent:
        agent === undefined
          ? null
          : {
              id: agent.id,
              jobId: agent.jobId,
              status: agent.status,
              // A missing link in the chain counts as revoked.
              ancestorRevoked:
                ancestors.some((a) => a.status === "REVOKED") ||
                (agent.parentAgentId !== null && ancestors.length === 0),
              limit: agent.spendLimit,
              committed: agent.committed,
              ancestorLimits: ancestors.flatMap((a) =>
                a.spendLimit === null ? [] : [{ limit: a.spendLimit, committed: a.committed }],
              ),
            },
      payee: payee === undefined ? null : { category },
      categoryLimit:
        limit === undefined ? null : { limit: limit.spendLimit, committed: limit.committed },
      request: { amount: input.amount },
      now,
    });

    const counts = outcome.outcome !== "DENIED";
    // A quoted purchase: what will be sent to the seller, hashed into the decision's audit entry.
    const requestOf =
      input.payment === undefined
        ? null
        : storedRequestOf({
            paymentUrl: input.payment.url,
            paymentRequirements: input.payment.quote,
          });
    const [decision] = await tx
      .insert(decisions)
      .values({
        jobId: job.id,
        agentId: principal.agentId,
        operationId: input.operationId,
        kind: input.kind,
        payee: payeeValue,
        amount: input.amount,
        category,
        invoiceRef: input.invoiceRef ?? null,
        resourceUrl: input.resourceUrl ?? input.payment?.url ?? null,
        requestHash: requestOf === null ? null : requestHashOf(requestOf),
        payeeSource: input.allowedBy?.source ?? null,
        reasoning: input.reasoning,
        result: outcome.outcome,
        reason: outcome.outcome === "DENIED" ? outcome.reason : null,
        checks: outcome.checks,
        remainingAtDecision: job.budget - committed - (counts ? input.amount - covered : 0n),
        // The on-chain rules this was decided under; the vault rejects the release if they changed.
        policyVersion: job.policyVersion,
      })
      .returning();
    if (decision === undefined) throw new Error("decision insert returned nothing");
    await appendAudit(tx, {
      jobId: job.id,
      event: "decision",
      refId: decision.id,
      payload: decisionPayload(decision),
    });
    if (!counts) {
      return { replayed: false, decision, authorization: null };
    }

    const state: AuthorizationState =
      outcome.outcome === "ALLOWED" ? "RESERVED" : "PENDING_APPROVAL";
    const window = currentWindow(job, now);
    const bucket = state === "RESERVED" ? jobs.reserved : jobs.pending;
    await tx
      .update(jobs)
      .set({
        [state === "RESERVED" ? "reserved" : "pending"]:
          sql`${bucket} + ${bigintParam(input.amount)}`,
        // A Gateway payment holds its amount against the job's float from the start.
        ...(rail === "GATEWAY"
          ? { gatewayDrawn: sql`${jobs.gatewayDrawn} + ${bigintParam(input.amount)}` }
          : {}),
        windowStart: window.start,
        windowSpent: window.spent + input.amount,
      })
      .where(eq(jobs.id, job.id));
    await commitAlongLineage(tx, principal.agentId, input.amount, chain);
    if (limit !== undefined) {
      await tx
        .update(categoryLimits)
        .set({ committed: sql`${categoryLimits.committed} + ${bigintParam(input.amount)}` })
        .where(eq(categoryLimits.id, limit.id));
    }
    const [authorization] = await tx
      .insert(authorizations)
      .values({
        decisionId: decision.id,
        jobId: job.id,
        agentId: principal.agentId,
        amount: input.amount,
        category,
        state,
        paymentUrl: input.payment?.url ?? null,
        // An address payee is paid straight from the vault (an invoice): the release is the payment.
        payTo: input.payee.kind === "ADDRESS" ? payeeValue : null,
        paymentRequirements: input.payment?.quote ?? null,
        rail,
      })
      .returning();
    return { replayed: false, decision, authorization: authorization ?? null };
  });
}

// State changes live in @bursar/db so the worker applies exactly the same counter rules.
export { transition, type TransitionPatch } from "@bursar/db";
