import { formatUsdc, parseUsdc } from "@bursar/money";
import {
  agents,
  approvals,
  approvers,
  auditAnchors,
  auditChain,
  authorizations,
  chainEvents,
  decisions,
  jobs,
  operatorRuns,
  payees,
  type Db,
} from "@bursar/db";
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { agentView, authorizationView, jobView } from "../http/views.js";
import { notFound } from "../http/errors.js";
import { getOwnedJob } from "./jobs.js";

/** Everything the console reads, always scoped to the signed-in owner. */

export async function listJobs(db: Db, ownerId: string) {
  const rows = await db
    .select()
    .from(jobs)
    .where(eq(jobs.ownerId, ownerId))
    .orderBy(desc(jobs.createdAt));
  if (rows.length === 0) return [];
  const ids = rows.map((j) => j.id);
  const agentCounts = await db
    .select({ jobId: agents.jobId, n: sql<number>`count(*)::int` })
    .from(agents)
    .where(and(inArray(agents.jobId, ids), eq(agents.status, "ACTIVE")))
    .groupBy(agents.jobId);
  const waiting = await db
    .select({ jobId: authorizations.jobId, n: sql<number>`count(*)::int` })
    .from(authorizations)
    .where(and(inArray(authorizations.jobId, ids), eq(authorizations.state, "PENDING_APPROVAL")))
    .groupBy(authorizations.jobId);
  const count = (list: { jobId: string; n: number }[], id: string) =>
    list.find((r) => r.jobId === id)?.n ?? 0;
  return rows.map((j) => ({
    ...jobView(j),
    agents: count(agentCounts, j.id),
    needsYou: count(waiting, j.id),
  }));
}

/**
 * What Bursar's own AI operator produced for a job, newest first: each run's answer (its summary
 * for the owner), the brief it worked from, how it ended and what the model cost. The summary was
 * written by a model that read seller content: show it as text, never as markup.
 */
export async function jobRuns(db: Db, ownerId: string, jobId: string, limit = 20) {
  const job = await getOwnedJob(db, ownerId, jobId);
  // A helper's own run is part of the run that spawned it, so only the operator's runs are listed.
  const rows = await db
    .select({ run: operatorRuns })
    .from(operatorRuns)
    .innerJoin(agents, eq(agents.id, operatorRuns.agentId))
    .where(and(eq(operatorRuns.jobId, job.id), isNull(agents.parentAgentId)))
    .orderBy(desc(operatorRuns.createdAt))
    .limit(limit);
  return rows.map((r) => runView(r.run));
}

function runView(r: typeof operatorRuns.$inferSelect) {
  return {
    id: r.id,
    at: r.createdAt.toISOString(),
    outcome: r.outcome,
    summary: r.summary,
    brief: ownersBrief(r.brief),
    steps: r.steps,
    model: r.model,
    /** The AI model's cost in USD (not USDC paid on-chain). */
    aiCost: (Number(r.costMicros) / 1_000_000).toFixed(4),
  };
}

/**
 * What the owner wrote. A run's brief also carries what Bursar added for the operator (earlier
 * runs, new revenue); those notes aren't part of the owner's brief.
 */
export function ownersBrief(stored: string): string {
  const added = stored.search(/\n\n(?:What earlier runs on this job already did|New revenue:)/);
  return (added === -1 ? stored : stored.slice(0, added)).trim();
}

/**
 * One result: the run, and what it bought to produce it. A run's purchases are the decisions its
 * operator (and the helpers it started) made after the job's previous run and up to this one.
 */
export async function runResult(db: Db, ownerId: string, jobId: string, runId: string) {
  const job = await getOwnedJob(db, ownerId, jobId);
  const [run] = await db
    .select()
    .from(operatorRuns)
    .where(and(eq(operatorRuns.jobId, job.id), eq(operatorRuns.id, runId)));
  if (run === undefined) throw notFound("Result");
  // The run before this one, not counting helpers' runs (they finish inside this run).
  const [previous] = await db
    .select({ at: operatorRuns.createdAt })
    .from(operatorRuns)
    .innerJoin(agents, eq(agents.id, operatorRuns.agentId))
    .where(
      and(
        eq(operatorRuns.jobId, job.id),
        isNull(agents.parentAgentId),
        lt(operatorRuns.createdAt, run.createdAt),
      ),
    )
    .orderBy(desc(operatorRuns.createdAt))
    .limit(1);
  const helpers = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.parentAgentId, run.agentId));
  const who = new Set([run.agentId, ...helpers.map((h) => h.id)]);
  const from = previous?.at.getTime() ?? 0;
  const to = run.createdAt.getTime();
  const purchases = (await jobDecisions(db, ownerId, job.id, 500)).filter((d) => {
    const at = new Date(d.at).getTime();
    return who.has(d.agent.id) && at > from && at <= to;
  });
  const paid = purchases
    .filter((d) => d.state === "SETTLED")
    .reduce((sum, d) => sum + parseUsdc(d.amount), 0n);
  return {
    job: { id: job.id, title: job.title },
    run: runView(run),
    purchases,
    /** USDC paid for this result (settled purchases only). */
    paid: formatUsdc(paid),
  };
}

/** A job's decisions, newest first, each with its payment's state and the payee's label. */
export async function jobDecisions(db: Db, ownerId: string, jobId: string, limit = 100) {
  const job = await getOwnedJob(db, ownerId, jobId);
  return decisionRows(db, eq(decisions.jobId, job.id), limit);
}

/** Every decision across the owner's jobs, newest first, each naming its job: the daybook. */
export async function ownerActivity(db: Db, ownerId: string, limit = 100) {
  return decisionRows(db, eq(jobs.ownerId, ownerId), limit);
}

async function decisionRows(db: Db, where: ReturnType<typeof eq>, limit: number) {
  const rows = await db
    .select({
      decision: decisions,
      auth: authorizations,
      agent: agents,
      payee: payees,
      job: { id: jobs.id, title: jobs.title },
    })
    .from(decisions)
    .innerJoin(jobs, eq(jobs.id, decisions.jobId))
    .innerJoin(agents, eq(agents.id, decisions.agentId))
    .leftJoin(authorizations, eq(authorizations.decisionId, decisions.id))
    .leftJoin(payees, and(eq(payees.jobId, decisions.jobId), eq(payees.value, decisions.payee)))
    .where(where)
    .orderBy(desc(decisions.createdAt))
    .limit(limit);
  return rows.map(({ decision: d, auth, agent, payee, job }) => ({
    id: d.id,
    at: d.createdAt.toISOString(),
    job,
    agent: { id: agent.id, name: agent.name, role: agent.role },
    kind: d.kind,
    payee: d.payee,
    payeeLabel: payee?.label ?? null,
    invoiceRef: d.invoiceRef,
    amount: formatUsdc(d.amount),
    reasoning: d.reasoning,
    result: d.result,
    reason: d.reason,
    /** The payment's state, or null when the decision was a denial (nothing was reserved). */
    state: auth?.state ?? null,
    authorizationId: auth?.id ?? null,
    /** For purchases: the exact resource bought (the payee is only its origin). */
    paymentUrl: auth?.paymentUrl ?? d.resourceUrl ?? null,
    paymentTx: auth?.paymentTx ?? null,
    /** Images, audio and video the seller delivered, kept by us. */
    media: Array.isArray(auth?.media) ? auth.media : [],
    /** VAULT or GATEWAY (a Circle Gateway nano payment, with no per-payment transaction). */
    rail: auth?.rail ?? null,
  }));
}

/** Who the job may pay: x402 sellers (origins) and vendors (addresses). */
export async function jobPayees(db: Db, ownerId: string, jobId: string) {
  const job = await getOwnedJob(db, ownerId, jobId);
  const rows = await db
    .select()
    .from(payees)
    .where(eq(payees.jobId, job.id))
    .orderBy(asc(payees.createdAt));
  return rows.map((p) => ({
    id: p.id,
    kind: p.kind,
    value: p.value,
    label: p.label,
    category: p.category,
    filters: marketplaceFilters(p.filters),
  }));
}

/** A marketplace entry's filters as the console shows them: categories and a USDC max price. */
export function marketplaceFilters(stored: unknown) {
  if (stored === null || typeof stored !== "object") return null;
  const f = stored as { categories?: unknown; maxPrice?: unknown };
  return {
    categories: Array.isArray(f.categories) ? f.categories.map(String) : [],
    maxPrice: typeof f.maxPrice === "string" ? formatUsdc(BigInt(f.maxPrice)) : null,
  };
}

export async function jobAgents(db: Db, ownerId: string, jobId: string) {
  const job = await getOwnedJob(db, ownerId, jobId);
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.jobId, job.id))
    .orderBy(asc(agents.createdAt));
  return rows.map(agentView);
}

/** One decision's full trail: request, policy checks, approval, payment, audit log, anchor. */
export async function decisionEvidence(db: Db, ownerId: string, decisionId: string) {
  const [row] = await db
    .select({ decision: decisions, job: jobs, agent: agents })
    .from(decisions)
    .innerJoin(jobs, eq(jobs.id, decisions.jobId))
    .innerJoin(agents, eq(agents.id, decisions.agentId))
    .where(and(eq(decisions.id, decisionId), eq(jobs.ownerId, ownerId)));
  if (row === undefined) throw notFound("Decision");
  const { decision: d, job, agent } = row;
  const [auth] = await db.select().from(authorizations).where(eq(authorizations.decisionId, d.id));
  const [approval] =
    auth === undefined
      ? []
      : await db
          .select({ approval: approvals, approver: approvers })
          .from(approvals)
          .leftJoin(approvers, eq(approvers.id, approvals.approverId))
          .where(eq(approvals.authorizationId, auth.id));
  const refs = auth === undefined ? [d.id] : [d.id, auth.id];
  const entries = await db
    .select()
    .from(auditChain)
    .where(inArray(auditChain.refId, refs))
    .orderBy(asc(auditChain.seq));
  const firstSeq = entries[0]?.seq;
  const anchors =
    firstSeq === undefined
      ? []
      : await db
          .select()
          .from(auditAnchors)
          .where(and(eq(auditAnchors.status, "CONFIRMED"), gte(auditAnchors.chainSeq, firstSeq)))
          .orderBy(asc(auditAnchors.chainSeq));
  const lastSeq = entries.at(-1)?.seq;
  const anchor = lastSeq === undefined ? undefined : anchors.find((a) => a.chainSeq >= lastSeq);
  return {
    job: { id: job.id, title: job.title },
    agent: { id: agent.id, name: agent.name, role: agent.role },
    decision: {
      id: d.id,
      at: d.createdAt.toISOString(),
      kind: d.kind,
      payee: d.payee,
      invoiceRef: d.invoiceRef,
      amount: formatUsdc(d.amount),
      reasoning: d.reasoning,
      result: d.result,
      reason: d.reason,
      checks: d.checks,
      operationId: d.operationId,
      policyVersion: d.policyVersion,
    },
    payment: auth === undefined ? null : authorizationView(auth),
    approval:
      approval === undefined
        ? null
        : {
            verdict: approval.approval.verdict,
            approver: approval.approver?.name ?? null,
            approverAddress: approval.approval.approverAddress,
            note: approval.approval.note,
            at: approval.approval.decidedAt.toISOString(),
          },
    audit: entries.map((e) => ({
      seq: e.seq,
      event: e.event,
      hash: e.hash,
      prevHash: e.prevHash,
      payloadHash: e.payloadHash,
      payload: e.payload,
      at: e.createdAt.toISOString(),
    })),
    anchor:
      anchor === undefined
        ? null
        : {
            anchorSeq: anchor.anchorSeq,
            coversUpTo: anchor.chainSeq,
            head: anchor.head,
            txHash: anchor.txHash,
            at: (anchor.confirmedAt ?? anchor.sentAt).toISOString(),
          },
  };
}

/**
 * A cheap fingerprint of everything an owner can see. The live stream sends "change" whenever it
 * moves, and the console refetches. Every decision and payment step appends to the audit log, so
 * its head covers most changes; job counters (deposits, revenue) and agents cover the rest.
 */
export async function ownerFingerprint(db: Db, ownerId: string): Promise<string> {
  const [row] = (await db.execute(sql`
    select
      (select coalesce(max(a.seq), 0) from audit_chain a join jobs j on j.id = a.job_id
        where j.owner_id = ${ownerId}) as audit,
      (select coalesce(sum(j.deposited + j.revenue_received), 0) || ':' || count(*)
         || ':' || coalesce(string_agg(j.status::text, ',' order by j.id), '')
         from jobs j where j.owner_id = ${ownerId}) as jobs,
      (select count(*) || ':' || count(*) filter (where ag.status = 'REVOKED')
         from agents ag join jobs j on j.id = ag.job_id where j.owner_id = ${ownerId}) as agents,
      (select coalesce(max(an.anchor_seq), 0) from audit_anchors an
        where an.status = 'CONFIRMED') as anchors`)) as unknown as Record<string, unknown>[];
  return JSON.stringify(row ?? {});
}

/**
 * The on-chain transaction that closed a job and returned its money, read from the vault events the
 * indexer recorded. Null while the job is open, or if the event hasn't been indexed yet.
 */
export async function closeTxOf(
  db: Db,
  job: Pick<typeof jobs.$inferSelect, "vaultJobId" | "status">,
): Promise<string | null> {
  if (job.status !== "CLOSED" || job.vaultJobId === null) return null;
  const [row] = await db
    .select({ txHash: chainEvents.txHash })
    .from(chainEvents)
    .where(
      and(
        eq(chainEvents.vaultJobId, job.vaultJobId),
        inArray(chainEvents.eventName, ["Withdrawn", "StatusChanged"]),
      ),
    )
    .orderBy(desc(chainEvents.blockNumber), desc(chainEvents.logIndex))
    .limit(1);
  return row?.txHash ?? null;
}

export interface JobEvent {
  id: string;
  at: string;
  kind: "created" | "opened" | "funded" | "closed";
  jobId: string;
  jobTitle: string;
  txHash: string | null;
}

/**
 * The life of the owner's jobs, for the daybook beside the payments: created, opened on Arc,
 * funded, closed. Opened, funded and closed come with the vault transaction that did it.
 */
export async function ownerJobEvents(db: Db, ownerId: string, limit = 100): Promise<JobEvent[]> {
  const rows = await db.select().from(jobs).where(eq(jobs.ownerId, ownerId));
  if (rows.length === 0) return [];
  const byVault = new Map(rows.filter((j) => j.vaultJobId !== null).map((j) => [j.vaultJobId!, j]));
  const events: JobEvent[] = rows.map((j) => ({
    id: `created-${j.id}`,
    at: j.createdAt.toISOString(),
    kind: "created",
    jobId: j.id,
    jobTitle: j.title,
    txHash: null,
  }));
  if (byVault.size > 0) {
    const chain = await db
      .select()
      .from(chainEvents)
      .where(
        and(
          inArray(chainEvents.vaultJobId, [...byVault.keys()]),
          inArray(chainEvents.eventName, ["JobCreated", "Funded", "Withdrawn"]),
        ),
      );
    for (const e of chain) {
      const job = byVault.get(e.vaultJobId ?? "");
      if (job === undefined) continue;
      // Withdrawn is the vault paying a closed job's money back: that is the close.
      if (e.eventName === "Withdrawn" && job.status !== "CLOSED") continue;
      events.push({
        id: `${e.eventName}-${e.id}`,
        at: e.appliedAt.toISOString(),
        kind:
          e.eventName === "JobCreated" ? "opened" : e.eventName === "Funded" ? "funded" : "closed",
        jobId: job.id,
        jobTitle: job.title,
        txHash: e.txHash,
      });
    }
  }
  return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
