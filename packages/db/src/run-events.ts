import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "./client.js";
import { runEvents } from "./schema.js";

export type RunEventKind =
  | "started"
  | "step"
  | "found"
  | "paid"
  | "blocked"
  | "waiting"
  | "helper"
  | "retry"
  | "error"
  | "finished";

/** Lines are short by design: they're a progress feed, not a transcript. */
const MAX_TEXT = 500;

/** Events older than this are deleted. The decisions and audit log keep the real record. */
export const RUN_EVENT_RETENTION_DAYS = 30;

/** A run with no news for this long is treated as over (a worker that died mid-run). */
export const RUN_STALE_MS = 10 * 60_000;

export async function addRunEvent(
  db: Db,
  event: { jobId: string; runKey: string; depth?: number; kind: RunEventKind; text: string },
): Promise<void> {
  await db.insert(runEvents).values({
    jobId: event.jobId,
    runKey: event.runKey,
    depth: event.depth ?? 0,
    kind: event.kind,
    text: event.text.slice(0, MAX_TEXT),
  });
}

/** Deletes events past their retention. Returns how many were removed. */
export async function pruneRunEvents(db: Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RUN_EVENT_RETENTION_DAYS * 86_400_000);
  const removed = await db
    .delete(runEvents)
    .where(lt(runEvents.createdAt, cutoff))
    .returning({ id: runEvents.id });
  return removed.length;
}

export interface LiveRun {
  /** True while the latest run is still going. */
  active: boolean;
  runKey: string | null;
  events: { id: number; at: string; depth: number; kind: string; text: string }[];
}

const FINAL_KINDS = new Set(["finished", "retry", "error"]);

/**
 * The newest run's events for a job, oldest first. `active` is true while that run hasn't
 * reported its end and has said something recently.
 */
export async function latestRunEvents(
  db: Db,
  jobId: string,
  options: { limit?: number; now?: Date } = {},
): Promise<LiveRun> {
  const [last] = await db
    .select({ runKey: runEvents.runKey })
    .from(runEvents)
    .where(eq(runEvents.jobId, jobId))
    .orderBy(desc(runEvents.id))
    .limit(1);
  if (last === undefined) return { active: false, runKey: null, events: [] };
  const rows = await db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.jobId, jobId), eq(runEvents.runKey, last.runKey)))
    .orderBy(desc(runEvents.id))
    .limit(options.limit ?? 200);
  rows.reverse();
  const newest = rows.at(-1);
  const now = (options.now ?? new Date()).getTime();
  const active =
    newest !== undefined &&
    !FINAL_KINDS.has(newest.kind) &&
    now - newest.createdAt.getTime() < RUN_STALE_MS;
  return {
    active,
    runKey: last.runKey,
    events: rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      depth: r.depth,
      kind: r.kind,
      text: r.text,
    })),
  };
}
