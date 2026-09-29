import { createHash, createHmac } from "node:crypto";
import {
  alertTargets,
  alerts,
  authorizations,
  chainCursors,
  committedOf,
  decisions,
  jobs,
  telegramLinks,
  type Db,
} from "@bursar/db";
import { formatUsdc } from "@bursar/money";
import { assertFetchable } from "@bursar/payments";
import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { log } from "./log.js";

export interface AlertDeps {
  readonly db: Db;
  /** The console's address, for links in alerts. */
  readonly webUrl: string;
  /** Telegram bot token; without it Telegram is skipped. */
  readonly telegramToken?: string | undefined;
  /** Local development only: allow webhooks to 127.0.0.1. */
  readonly allowPrivateWebhooks?: boolean;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

const MAX_ATTEMPTS = 8;
const STUCK_AFTER_MS = 5 * 60_000;
const BURST_WINDOW_MS = 10 * 60_000;
const BURST_COUNT = 3;
const LINK_TTL_MS = 60 * 60_000;

const usdc = (units: bigint) => `${formatUsdc(units)} USDC`;
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

interface NewAlert {
  ownerId: string;
  jobId: string | null;
  type: string;
  dedupeKey: string;
  title: string;
  body: string;
  link: string;
}

/** Queues each alert once; the unique dedupe key makes re-running this harmless. */
async function queue(db: Db, list: NewAlert[], now: Date): Promise<number> {
  if (list.length === 0) return 0;
  // Due from the same clock the sender compares against (not the database's).
  const inserted = await db
    .insert(alerts)
    .values(list.map((a) => ({ ...a, nextAttemptAt: now })))
    .onConflictDoNothing()
    .returning({ id: alerts.id });
  return inserted.length;
}

/** Looks for anything an owner should hear about and queues it. Returns how many were new. */
export async function produceAlerts(deps: AlertDeps): Promise<number> {
  const { db, webUrl } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const list: NewAlert[] = [];

  // A payment waiting for a human.
  const waiting = await db
    .select({ auth: authorizations, job: jobs, decision: decisions })
    .from(authorizations)
    .innerJoin(jobs, eq(jobs.id, authorizations.jobId))
    .innerJoin(decisions, eq(decisions.id, authorizations.decisionId))
    .where(
      and(
        eq(authorizations.state, "PENDING_APPROVAL"),
        gt(authorizations.createdAt, new Date(now.getTime() - 24 * 3600_000)),
      ),
    );
  for (const { auth, job, decision } of waiting) {
    list.push({
      ownerId: job.ownerId,
      jobId: job.id,
      type: "needs_approval",
      dedupeKey: `approval:${auth.id}`,
      title: `${usdc(auth.amount)} needs your approval`,
      body: `${job.title}: "${clip(decision.reasoning, 140)}"`,
      link: `${webUrl}/app/approvals`,
    });
  }

  // A payment the chain hasn't settled or refused after a while.
  const stuck = await db
    .select({ auth: authorizations, job: jobs })
    .from(authorizations)
    .innerJoin(jobs, eq(jobs.id, authorizations.jobId))
    .where(
      and(
        eq(authorizations.state, "UNRESOLVED"),
        lte(authorizations.updatedAt, new Date(now.getTime() - STUCK_AFTER_MS)),
      ),
    );
  for (const { auth, job } of stuck) {
    list.push({
      ownerId: job.ownerId,
      jobId: job.id,
      type: "stuck_payment",
      dedupeKey: `stuck:${auth.id}`,
      title: "A payment is stuck",
      body: `${usdc(auth.amount)} in ${job.title} hasn't settled after 5 minutes. Bursar keeps checking the chain.`,
      link: `${webUrl}/app/jobs/${job.id}`,
    });
  }

  // Jobs that have used 80% of their budget (once per job).
  const nearlySpent = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "ACTIVE"),
        sql`${jobs.budget} > 0 and (${jobs.settled} + ${jobs.reserved} + ${jobs.pending} + ${jobs.unresolved} + greatest(${jobs.gatewayFunded} - ${jobs.gatewayDrawn}, 0)) * 5 >= ${jobs.budget} * 4`,
      ),
    );
  for (const job of nearlySpent) {
    const left = job.budget - committedOf(job);
    list.push({
      ownerId: job.ownerId,
      jobId: job.id,
      type: "budget_80",
      dedupeKey: `budget80:${job.id}`,
      title: `${job.title} has used 80% of its budget`,
      body: `${usdc(left)} left of ${usdc(job.budget)}.`,
      link: `${webUrl}/app/jobs/${job.id}`,
    });
  }

  // Frozen jobs (an unexplained payout). Keyed by the reason, so a new freeze alerts again.
  const frozen = await db
    .select()
    .from(jobs)
    .where(sql`${jobs.frozenReason} is not null`);
  for (const job of frozen) {
    const reason = job.frozenReason ?? "";
    list.push({
      ownerId: job.ownerId,
      jobId: job.id,
      type: "job_frozen",
      dedupeKey: `frozen:${job.id}:${createHash("sha1").update(reason).digest("hex").slice(0, 12)}`,
      title: `${job.title} was frozen`,
      body: clip(reason, 220),
      link: `${webUrl}/app/jobs/${job.id}`,
    });
  }

  // Bursts of blocked requests: often an agent that's confused or being pushed.
  const bucket = Math.floor(now.getTime() / BURST_WINDOW_MS);
  const bursts = (await db.execute(sql`
    select j.id, j.owner_id, j.title, count(*)::int as n,
           mode() within group (order by d.reason) as reason
      from decisions d join jobs j on j.id = d.job_id
     where d.result = 'DENIED' and d.created_at > ${new Date(now.getTime() - BURST_WINDOW_MS).toISOString()}::timestamptz
     group by j.id, j.owner_id, j.title
    having count(*) >= ${BURST_COUNT}`)) as unknown as {
    id: string;
    owner_id: string;
    title: string;
    n: number;
    reason: string | null;
  }[];
  for (const b of bursts) {
    list.push({
      ownerId: b.owner_id,
      jobId: b.id,
      type: "denial_burst",
      dedupeKey: `denials:${b.id}:${bucket}`,
      title: `${b.n} requests blocked on ${b.title}`,
      body: `Mostly ${String(b.reason ?? "various reasons")
        .toLowerCase()
        .replace(/_/g, " ")}, in the last 10 minutes.`,
      link: `${webUrl}/app/jobs/${b.id}`,
    });
  }

  return queue(db, list, now);
}

/** Signs a webhook body the way receivers verify it: HMAC-SHA256 of "<timestamp>.<body>". */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Sends queued alerts to every target of their owner, with retries and backoff. */
export async function deliverAlerts(deps: AlertDeps): Promise<number> {
  const { db } = deps;
  const doFetch = deps.fetch ?? fetch;
  const now = (deps.now ?? (() => new Date()))();
  const due = await db
    .select()
    .from(alerts)
    .where(and(isNull(alerts.sentAt), isNull(alerts.failedAt), lte(alerts.nextAttemptAt, now)))
    .orderBy(asc(alerts.createdAt))
    .limit(20);

  for (const alert of due) {
    const targets = await db
      .select()
      .from(alertTargets)
      .where(eq(alertTargets.ownerId, alert.ownerId));
    const errors: string[] = [];
    for (const target of targets) {
      try {
        if (target.kind === "WEBHOOK" && target.url !== null && target.secret !== null) {
          const safe = await assertFetchable(target.url, deps.allowPrivateWebhooks ?? false);
          const body = JSON.stringify({
            id: alert.id,
            type: alert.type,
            title: alert.title,
            body: alert.body,
            link: alert.link,
            jobId: alert.jobId,
            createdAt: alert.createdAt.toISOString(),
          });
          const timestamp = String(Math.floor(now.getTime() / 1000));
          const response = await doFetch(safe, {
            method: "POST",
            redirect: "manual",
            signal: AbortSignal.timeout(5_000),
            headers: {
              "content-type": "application/json",
              "x-bursar-event": alert.type,
              "x-bursar-timestamp": timestamp,
              "x-bursar-signature": signWebhook(target.secret, timestamp, body),
            },
            body,
          });
          if (!response.ok) throw new Error(`webhook answered ${response.status}`);
        } else if (target.kind === "TELEGRAM" && target.chatId !== null && deps.telegramToken) {
          await telegram(deps, "sendMessage", {
            chat_id: target.chatId,
            text: `${alert.title}\n${alert.body}${alert.link ? `\n${alert.link}` : ""}`,
            disable_web_page_preview: true,
          });
        }
      } catch (error) {
        errors.push(
          `${target.kind.toLowerCase()}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (errors.length === 0) {
      await db
        .update(alerts)
        .set({ sentAt: now, lastError: targets.length === 0 ? "no alert targets" : null })
        .where(eq(alerts.id, alert.id));
    } else {
      const attempts = alert.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS;
      await db
        .update(alerts)
        .set({
          attempts,
          lastError: clip(errors.join("; "), 500),
          nextAttemptAt: new Date(now.getTime() + Math.min(3600_000, 60_000 * 2 ** (attempts - 1))),
          failedAt: giveUp ? now : null,
        })
        .where(eq(alerts.id, alert.id));
      log.warn("alert delivery failed", { alertId: alert.id, attempts, errors, alert: giveUp });
    }
  }
  return due.length;
}

async function telegram(deps: AlertDeps, method: string, payload: unknown): Promise<unknown> {
  const response = await (deps.fetch ?? fetch)(
    `https://api.telegram.org/bot${deps.telegramToken}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
    result?: unknown;
  };
  // Never include the URL in errors: it contains the bot token.
  if (!response.ok || json.ok !== true)
    throw new Error(`telegram ${method} failed: ${json.description ?? response.status}`);
  return json.result;
}

/**
 * Links Telegram chats: an owner opens t.me/<bot>?start=<code> from the console, the bot receives
 * "/start <code>", and that chat starts getting the owner's alerts. Reads updates from where it
 * left off (stored like a chain cursor), so each message is handled once.
 */
export async function pollTelegram(deps: AlertDeps): Promise<number> {
  if (!deps.telegramToken) return 0;
  const { db } = deps;
  const [cursor] = await db.select().from(chainCursors).where(eq(chainCursors.name, "telegram"));
  const updates = (await telegram(deps, "getUpdates", {
    offset: (cursor?.block ?? 0) + 1,
    timeout: 0,
    allowed_updates: ["message"],
  })) as { update_id: number; message?: { chat?: { id: number }; text?: string } }[];
  let linked = 0;
  for (const update of updates) {
    const text = update.message?.text ?? "";
    const chatId = update.message?.chat?.id;
    const code = /^\/start\s+([A-Za-z0-9_-]{8,64})$/.exec(text.trim())?.[1];
    if (code !== undefined && chatId !== undefined) {
      const [link] = await db
        .update(telegramLinks)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(telegramLinks.code, code),
            isNull(telegramLinks.usedAt),
            gt(telegramLinks.createdAt, new Date(Date.now() - LINK_TTL_MS)),
          ),
        )
        .returning();
      if (link !== undefined) {
        // One chat per account: a newer link replaces the old chat instead of adding a second.
        await db.transaction(async (tx) => {
          await tx
            .delete(alertTargets)
            .where(and(eq(alertTargets.ownerId, link.ownerId), eq(alertTargets.kind, "TELEGRAM")));
          await tx
            .insert(alertTargets)
            .values({ ownerId: link.ownerId, kind: "TELEGRAM", chatId: String(chatId) });
        });
        linked += 1;
      }
      await telegram(deps, "sendMessage", {
        chat_id: chatId,
        text:
          link === undefined
            ? "That link has expired. Open a new one from Bursar's settings."
            : "Linked. Bursar alerts for your jobs will arrive here.",
      }).catch(() => undefined);
    }
    await db
      .insert(chainCursors)
      .values({ name: "telegram", block: update.update_id })
      .onConflictDoUpdate({
        target: chainCursors.name,
        set: { block: update.update_id, updatedAt: new Date() },
      });
  }
  return linked;
}
