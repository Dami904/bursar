import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/**
 * Traction numbers (PLAN.md §13.3), computed straight from the ledger so they can't drift from
 * what actually happened. `ownerId` scopes them to one business; null means everyone.
 */
export interface Metrics {
  readonly businesses: number;
  readonly jobs: { readonly total: number; readonly live: number };
  /** Micro-USDC. */
  readonly usdc: {
    readonly revenueReceived: string;
    readonly paidOut: string;
    readonly refunded: string;
  };
  readonly decisions: {
    readonly total: number;
    readonly allowed: number;
    readonly needsApproval: number;
    /** Denied before anything was signed: every one is money that didn't leave. */
    readonly denied: number;
    readonly deniedByReason: Record<string, number>;
  };
  readonly approvals: {
    readonly approved: number;
    readonly rejected: number;
    readonly expired: number;
  };
  readonly payments: {
    readonly settled: number;
    readonly refunded: number;
    readonly unresolvedNow: number;
  };
  readonly ai: { readonly runs: number; readonly costMicros: string };
}

const n = (value: unknown) => Number(value ?? 0);
const s = (value: unknown) => String(value ?? "0");

export async function computeMetrics(db: Db, ownerId: string | null): Promise<Metrics> {
  const owner = ownerId === null ? sql`true` : sql`j.owner_id = ${ownerId}`;
  const [jobsRow] = (await db.execute(sql`
    select count(distinct j.owner_id) as businesses,
           count(*) as total,
           count(*) filter (where j.status = 'ACTIVE') as live,
           coalesce(sum(j.revenue_received), 0) as revenue,
           coalesce(sum(j.settled), 0) as paid_out,
           coalesce(sum(j.llm_cost_micros), 0) as ai_cost
      from jobs j where ${owner}`)) as unknown as Record<string, unknown>[];
  const decisionRows = (await db.execute(sql`
    select d.result, d.reason, count(*) as c
      from decisions d join jobs j on j.id = d.job_id
     where ${owner}
     group by d.result, d.reason`)) as unknown as Record<string, unknown>[];
  const [approvalRow] = (await db.execute(sql`
    select count(*) filter (where a.verdict = 'APPROVED') as approved,
           count(*) filter (where a.verdict = 'REJECTED') as rejected,
           count(*) filter (where a.verdict = 'EXPIRED') as expired
      from approvals a join authorizations au on au.id = a.authorization_id join jobs j on j.id = au.job_id
     where ${owner}`)) as unknown as Record<string, unknown>[];
  const [paymentRow] = (await db.execute(sql`
    select count(*) filter (where au.state = 'SETTLED') as settled,
           count(*) filter (where au.refund_tx is not null and au.state = 'RELEASED') as refunded,
           coalesce(sum(au.amount) filter (where au.refund_tx is not null and au.state = 'RELEASED'), 0) as refunded_amount,
           count(*) filter (where au.state = 'UNRESOLVED') as unresolved
      from authorizations au join jobs j on j.id = au.job_id
     where ${owner}`)) as unknown as Record<string, unknown>[];
  const [runRow] = (await db.execute(sql`
    select count(*) as runs from operator_runs r join jobs j on j.id = r.job_id where ${owner}`)) as unknown as Record<
    string,
    unknown
  >[];

  let total = 0;
  let allowed = 0;
  let needsApproval = 0;
  let denied = 0;
  const deniedByReason: Record<string, number> = {};
  for (const row of decisionRows) {
    const count = n(row.c);
    total += count;
    if (row.result === "ALLOWED") allowed += count;
    if (row.result === "NEEDS_APPROVAL") needsApproval += count;
    if (row.result === "DENIED") {
      denied += count;
      const reason = String(row.reason ?? "UNKNOWN");
      deniedByReason[reason] = (deniedByReason[reason] ?? 0) + count;
    }
  }

  return {
    businesses: n(jobsRow?.businesses),
    jobs: { total: n(jobsRow?.total), live: n(jobsRow?.live) },
    usdc: {
      revenueReceived: s(jobsRow?.revenue),
      paidOut: s(jobsRow?.paid_out),
      refunded: s(paymentRow?.refunded_amount),
    },
    decisions: { total, allowed, needsApproval, denied, deniedByReason },
    approvals: {
      approved: n(approvalRow?.approved),
      rejected: n(approvalRow?.rejected),
      expired: n(approvalRow?.expired),
    },
    payments: {
      settled: n(paymentRow?.settled),
      refunded: n(paymentRow?.refunded),
      unresolvedNow: n(paymentRow?.unresolved),
    },
    ai: { runs: n(runRow?.runs), costMicros: s(jobsRow?.ai_cost) },
  };
}
