import {
  agents,
  authorizations,
  credentials,
  decisions,
  issueKey,
  jobs,
  type Db,
} from "@bursar/db";
import { formatUsdc } from "@bursar/money";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { log } from "./log.js";

/** What one automatic run needs: the brief, and a key that works only for this run. */
export interface RunRequest {
  readonly jobId: string;
  readonly brief: string;
  readonly key: string;
}

export interface RunOutcome {
  readonly outcome: string;
  readonly summary: string;
  readonly costMicros: number;
  /** Model turns taken; 0 with outcome "error" means the run never got going. */
  readonly steps: number;
}

export interface AutopilotDeps {
  readonly db: Db;
  /** Runs the operator (the real one calls @bursar/operator over the Bursar API). */
  readonly run: (request: RunRequest) => Promise<RunOutcome>;
  /** Jobs with a run in progress. One run at a time keeps within model rate limits. */
  readonly running: Set<string>;
  /** Runs that never got going (model unavailable): when each job may try again. */
  readonly retries?: Map<string, { attempts: number; after: number }>;
}

const MAX_RETRIES = 5;
const retryDelay = (attempts: number) => Math.min(30 * 60_000, 2 * 60_000 * 2 ** (attempts - 1));

/**
 * Starts the AI operator on its own: when a job with a brief goes live, and again when new customer
 * revenue arrives. Each run gets a fresh key for the job's "Operator (auto)" agent, revoked when
 * the run ends, so no long-lived key exists. If the owner revokes that agent, automatic runs stop.
 * Returns the job it started, if any.
 */
export async function autopilotOnce(deps: AutopilotDeps): Promise<string | null> {
  if (deps.running.size > 0) return null;
  const { db } = deps;
  const now = Date.now();
  const coolingDown = [...(deps.retries ?? new Map())]
    .filter(([, r]) => r.after > now || r.attempts >= MAX_RETRIES)
    .map(([id]) => id);
  const notCoolingDown =
    coolingDown.length === 0
      ? sql`true`
      : sql`id not in (${sql.join(
          coolingDown.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`;

  // Claim one due job atomically, so two workers (or two ticks) never start the same run.
  const [claimed] = (await db.execute(sql`
    with next as (
      select id, operator_revenue_seen as seen, operator_run_at as last_run
        from jobs
       where status = 'ACTIVE' and brief is not null and frozen_reason is null
         and (operator_run_at is null or revenue_received > operator_revenue_seen)
         and ${notCoolingDown}
       order by created_at
       limit 1
       for update skip locked
    )
    update jobs
       set operator_run_at = now(), operator_revenue_seen = jobs.revenue_received
      from next
     where jobs.id = next.id
    returning jobs.id, jobs.owner_id, jobs.brief, jobs.revenue_received, jobs.autopilot_agent_id,
              next.seen, next.last_run`)) as unknown as {
    id: string;
    owner_id: string;
    brief: string;
    revenue_received: string;
    autopilot_agent_id: string | null;
    seen: string;
    last_run: Date | null;
  }[];
  if (claimed === undefined) return null;

  let agentId = claimed.autopilot_agent_id;
  if (agentId === null) {
    const [agent] = await db
      .insert(agents)
      .values({ jobId: claimed.id, name: "Operator (auto)", role: "operator" })
      .returning();
    if (agent === undefined) throw new Error("agent insert returned nothing");
    agentId = agent.id;
    await db.update(jobs).set({ autopilotAgentId: agentId }).where(eq(jobs.id, claimed.id));
  } else {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (agent === undefined || agent.status !== "ACTIVE") {
      log.info("autopilot skipped: its agent was revoked", { jobId: claimed.id });
      return null;
    }
  }

  const issued = issueKey("AGENT");
  const [credential] = await db
    .insert(credentials)
    .values({
      keyHash: issued.hash,
      keyPrefix: issued.prefix,
      role: "AGENT",
      ownerId: claimed.owner_id,
      jobId: claimed.id,
      agentId,
    })
    .returning();
  if (credential === undefined) throw new Error("credential insert returned nothing");

  const newRevenue = BigInt(claimed.revenue_received) - BigInt(claimed.seen);
  let brief = claimed.brief;
  if (claimed.last_run !== null && newRevenue > 0n) {
    brief += `\n\nNew revenue: a customer just paid ${formatUsdc(newRevenue)} USDC into this job.`;
  }
  const history = await recentHistory(db, claimed.id);
  if (history !== "") {
    brief += `\n\nWhat earlier runs on this job already did (don't repeat a purchase unless the brief asks for more):\n${history}`;
  }

  deps.running.add(claimed.id);
  log.info("autopilot run started", { jobId: claimed.id, newRevenue: newRevenue.toString() });
  void deps
    .run({ jobId: claimed.id, brief, key: issued.key })
    .then(async (result) => {
      log.info("autopilot run finished", {
        jobId: claimed.id,
        outcome: result.outcome,
        costMicros: result.costMicros,
      });
      if (result.outcome === "error" && result.steps === 0) {
        // Never got going (the model was unavailable): try again later, with backoff.
        const attempts = (deps.retries?.get(claimed.id)?.attempts ?? 0) + 1;
        deps.retries?.set(claimed.id, { attempts, after: Date.now() + retryDelay(attempts) });
        await db
          .update(jobs)
          .set({ operatorRunAt: null, operatorRevenueSeen: BigInt(claimed.seen) })
          .where(eq(jobs.id, claimed.id));
        log.warn("autopilot run will retry", {
          jobId: claimed.id,
          attempts,
          alert: attempts >= MAX_RETRIES,
        });
      } else {
        deps.retries?.delete(claimed.id);
      }
    })
    .catch((error: unknown) => log.error("autopilot run failed", error, { jobId: claimed.id }))
    .finally(async () => {
      // The run's key dies with the run.
      await db
        .update(credentials)
        .set({ revokedAt: new Date() })
        .where(and(eq(credentials.id, credential.id), isNull(credentials.revokedAt)))
        .catch((error: unknown) =>
          log.error("couldn't revoke an autopilot key", error, { alert: true }),
        );
      deps.running.delete(claimed.id);
    });
  return claimed.id;
}

/**
 * A few lines on what the job has already bought or tried, newest first, so each automatic run
 * knows what earlier runs did. Written by Bursar from its own records, not by a seller.
 */
async function recentHistory(db: Db, jobId: string): Promise<string> {
  const rows = await db
    .select({
      amount: decisions.amount,
      result: decisions.result,
      reason: decisions.reason,
      kind: decisions.kind,
      invoiceRef: decisions.invoiceRef,
      paymentUrl: authorizations.paymentUrl,
      payee: decisions.payee,
      state: authorizations.state,
      at: decisions.createdAt,
    })
    .from(decisions)
    .leftJoin(authorizations, eq(authorizations.decisionId, decisions.id))
    .where(eq(decisions.jobId, jobId))
    .orderBy(desc(decisions.createdAt))
    .limit(10);
  return rows
    .map((d) => {
      const what =
        d.kind === "INVOICE" ? `invoice ${d.invoiceRef ?? ""}`.trim() : (d.paymentUrl ?? d.payee);
      const outcome =
        d.result === "DENIED"
          ? `blocked (${d.reason ?? "rule"})`
          : d.state === "SETTLED"
            ? "paid"
            : (d.state ?? "held").toLowerCase().replace(/_/g, " ");
      return `- ${d.at.toISOString().slice(0, 16).replace("T", " ")}: ${what}, ${formatUsdc(d.amount)} USDC, ${outcome}`;
    })
    .join("\n");
}
