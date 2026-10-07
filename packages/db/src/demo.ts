import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { committedOf } from "./ledger.js";
import { agents, chainCursors, decisions, jobs, operatorRuns } from "./schema.js";

/**
 * The public demo job runs on request: a visitor clicks "Run a scene" and the next scene of a short
 * film's story is set for Bursar's AI operator. The scenes together show every kind of decision:
 * purchases, one that waits for approval, an invoice, one that's blocked, and sub-cent
 * nanopayments through Circle Gateway.
 */
export interface DemoScene {
  /** What a visitor sees on the button. */
  readonly title: string;
  /** What the operator is told to do. */
  readonly brief: string;
  /** The most the scene may spend, in micro-USDC: used to pace the demo's budget. */
  readonly maxCostMicros: bigint;
}

export const DEMO_SCENES: readonly DemoScene[] = [
  {
    title: "Buy a line of script dialogue",
    brief:
      "We're making a 60-second film about AI agents and money. Buy one line of script dialogue for the next scene from the allowed seller, and report it.",
    maxCostMicros: 20_000n,
  },
  {
    title: "Buy a stock image",
    brief:
      "Scene 2 needs a picture. Buy one stock image brief from the allowed seller and describe it.",
    maxCostMicros: 50_000n,
  },
  {
    title: "Buy the market report (waits for approval)",
    brief:
      "The closing scene needs numbers. Buy the market report from the allowed seller and summarise it in one line.",
    maxCostMicros: 150_000n,
  },
  {
    title: "Pay an invoice from the vault",
    brief:
      "The voice-over artist sent invoice VO-12 for 0.08 USDC for the narration, delivered and checked. Pay it to their wallet on the allow-list.",
    maxCostMicros: 80_000n,
  },
  {
    title: "Delegate to a helper with a small limit (gets blocked)",
    brief:
      "Delegate: spawn a helper with a 0.03 USDC limit and have it buy the market report for the credits. Report what happened.",
    maxCostMicros: 30_000n,
  },
  {
    title: "Buy sound and captions (Circle Gateway nanopayments)",
    brief:
      "Sound and captions: buy three sound cues and one caption from the allowed seller's nanopayment items (sub-cent, paid through Circle Gateway), then list what you got.",
    maxCostMicros: 20_000n,
  },
];

/** The rules that keep a public button from spending the demo's budget. */
export interface DemoRunPlan {
  /** The least time between two scenes, from the start of the last one. */
  readonly cooldownMs: number;
  /** The most scenes in any 24 hours. */
  readonly maxPerDay: number;
  /** The budget is paced so that it lasts until this moment. */
  readonly lastsUntil: Date;
  /** Micro-USDC the button can never spend, so the job still has money on the last day. */
  readonly reserveMicros: bigint;
}

export const DEFAULT_DEMO_PLAN: DemoRunPlan = {
  cooldownMs: 5 * 60_000,
  maxPerDay: 10,
  lastsUntil: new Date("2026-11-03T00:00:00Z"),
  reserveMicros: 100_000n,
};

export type DemoRunReason =
  "NOT_ACTIVE" | "PENDING" | "BUSY" | "COOLDOWN" | "DAILY_LIMIT" | "BUDGET_PACE";

export interface DemoRunInput {
  readonly now: Date;
  readonly plan: DemoRunPlan;
  /** The demo job is open and not frozen. */
  readonly active: boolean;
  /** When the current brief started running; null while a brief is waiting to run. */
  readonly lastRunAt: Date | null;
  /** A click that the worker hasn't served yet. */
  readonly requestPending: boolean;
  readonly runsLast24h: number;
  readonly spentLast24h: bigint;
  readonly remaining: bigint;
  readonly next: DemoScene;
}

export interface DemoRunVerdict {
  readonly canRun: boolean;
  readonly reason: DemoRunReason | null;
  /** When to try again, if waiting helps. */
  readonly retryAfterSeconds: number | null;
  /** What the budget allows per day from now until `lastsUntil`, in micro-USDC. */
  readonly allowancePerDay: bigint;
}

const DAY_MS = 86_400_000;

/**
 * Whether the next scene may run now. Pure, so the rules can be tested without a database. The
 * budget rule is the one that matters: a day's spending can't exceed what's left above a small
 * reserve, divided by the days remaining, so a public button can't empty the job before judging is
 * over.
 */
export function decideDemoRun(input: DemoRunInput): DemoRunVerdict {
  const daysLeft = Math.max((input.plan.lastsUntil.getTime() - input.now.getTime()) / DAY_MS, 1);
  // What can be spent is what's left above the reserve, spread over the days left.
  const spendable = Number(
    input.remaining > input.plan.reserveMicros ? input.remaining - input.plan.reserveMicros : 0n,
  );
  const allowancePerDay = BigInt(Math.floor(spendable / daysLeft));
  const no = (reason: DemoRunReason, retryAfterSeconds: number | null): DemoRunVerdict => ({
    canRun: false,
    reason,
    retryAfterSeconds,
    allowancePerDay,
  });

  if (!input.active) return no("NOT_ACTIVE", null);
  if (input.requestPending) return no("PENDING", 30);
  if (input.lastRunAt === null) return no("BUSY", 30);
  const sinceLast = input.now.getTime() - input.lastRunAt.getTime();
  if (sinceLast < input.plan.cooldownMs) {
    return no("COOLDOWN", Math.ceil((input.plan.cooldownMs - sinceLast) / 1000));
  }
  if (input.runsLast24h >= input.plan.maxPerDay) return no("DAILY_LIMIT", null);
  if (input.spentLast24h + input.next.maxCostMicros > allowancePerDay) {
    return no("BUDGET_PACE", null);
  }
  return { canRun: true, reason: null, retryAfterSeconds: null, allowancePerDay };
}

const REQUESTED = "demo-request";
const SERVED = "demo-served";
const BRIEF = "demo-brief";

async function cursor(db: Db, name: string): Promise<number> {
  const [row] = await db.select().from(chainCursors).where(eq(chainCursors.name, name));
  return row?.block ?? 0;
}

async function setCursor(db: Db, name: string, block: number, now: Date) {
  await db
    .insert(chainCursors)
    .values({ name, block })
    .onConflictDoUpdate({ target: chainCursors.name, set: { block, updatedAt: now } });
}

export interface DemoRunState {
  readonly verdict: DemoRunVerdict;
  readonly nextIndex: number;
  readonly next: DemoScene;
  readonly runsLast24h: number;
  readonly maxPerDay: number;
  readonly spentLast24h: bigint;
  readonly remaining: bigint;
}

/** Where the demo stands: what the next scene is, and whether a visitor may run it now. */
export async function demoRunState(
  db: Db,
  jobId: string,
  plan: DemoRunPlan = DEFAULT_DEMO_PLAN,
  now: Date = new Date(),
): Promise<DemoRunState | null> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (job === undefined) return null;
  const since = new Date(now.getTime() - DAY_MS);
  const [runs] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(operatorRuns)
    .innerJoin(agents, eq(agents.id, operatorRuns.agentId))
    .where(
      and(
        eq(operatorRuns.jobId, jobId),
        isNull(agents.parentAgentId),
        gte(operatorRuns.createdAt, since),
      ),
    );
  const [spent] = await db
    .select({ micros: sql<string>`coalesce(sum(${decisions.amount}), 0)::text` })
    .from(decisions)
    .where(
      and(
        eq(decisions.jobId, jobId),
        gte(decisions.createdAt, since),
        inArray(decisions.result, ["ALLOWED", "NEEDS_APPROVAL"]),
      ),
    );
  const nextIndex = await nextSceneIndex(db);
  const next = DEMO_SCENES[nextIndex] as DemoScene;
  const remaining = job.budget - committedOf(job);
  const requestPending = (await cursor(db, REQUESTED)) > (await cursor(db, SERVED));
  const runsLast24h = runs?.n ?? 0;
  const spentLast24h = BigInt(spent?.micros ?? "0");
  const verdict = decideDemoRun({
    now,
    plan,
    active: job.status === "ACTIVE" && job.frozenReason === null,
    lastRunAt: job.operatorRunAt,
    requestPending,
    runsLast24h,
    spentLast24h,
    remaining,
    next,
  });
  return {
    verdict,
    nextIndex,
    next,
    runsLast24h,
    maxPerDay: plan.maxPerDay,
    spentLast24h,
    remaining,
  };
}

/** The scene after the last one that was set (none set yet: the first). */
async function nextSceneIndex(db: Db): Promise<number> {
  const [row] = await db.select().from(chainCursors).where(eq(chainCursors.name, BRIEF));
  return row === undefined ? 0 : (row.block + 1) % DEMO_SCENES.length;
}

/** A visitor's click: queues the next scene, unless the rules say not now. */
export async function requestDemoRun(
  db: Db,
  jobId: string,
  plan: DemoRunPlan = DEFAULT_DEMO_PLAN,
  now: Date = new Date(),
): Promise<{ accepted: boolean; state: DemoRunState | null }> {
  const state = await demoRunState(db, jobId, plan, now);
  if (state === null || !state.verdict.canRun) return { accepted: false, state };
  // Seconds, and always ahead of the last one served, so two clicks in a second still count once.
  const served = await cursor(db, SERVED);
  await setCursor(db, REQUESTED, Math.max(Math.floor(now.getTime() / 1000), served + 1), now);
  return { accepted: true, state: await demoRunState(db, jobId, plan, now) };
}

/**
 * Moves the demo job to its next scene when a click is waiting. Called by the worker. Returns the
 * brief it set, or null when there's nothing to do (no click, the last brief hasn't run yet, or the
 * job is closed or frozen).
 */
export async function serveDemoRequest(
  db: Db,
  jobId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const requested = await cursor(db, REQUESTED);
  if (requested <= (await cursor(db, SERVED))) return null;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (job === undefined || job.status !== "ACTIVE" || job.frozenReason !== null) return null;
  // A brief is still waiting to run: it will, then this click is served on a later look.
  if (job.operatorRunAt === null) return null;

  const index = await nextSceneIndex(db);
  const scene = DEMO_SCENES[index] as DemoScene;
  await db.update(jobs).set({ brief: scene.brief, operatorRunAt: null }).where(eq(jobs.id, jobId));
  await setCursor(db, BRIEF, index, now);
  await setCursor(db, SERVED, requested, now);
  return scene.brief;
}
