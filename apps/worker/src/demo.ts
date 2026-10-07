import { DEMO_SCENES, chainCursors, jobs, serveDemoRequest, type Db } from "@bursar/db";
import { eq } from "drizzle-orm";
import type { Hex, TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { log } from "./log.js";

/**
 * The public demo job's scenes (shared with the API, which offers them to visitors). In the old
 * automatic mode the next one is set every few hours; by default it's set when a visitor clicks.
 */
export const DEMO_BRIEFS: readonly string[] = DEMO_SCENES.map((scene) => scene.brief);

export interface DemoDeps {
  readonly db: Db;
  readonly jobId: string;
  /** How long after a run the next brief starts. */
  readonly intervalMs: number;
  /** Jobs with a run in progress (shared with the autopilot). */
  readonly running: Set<string>;
  /**
   * Stands in for a person approving the demo job's payments, after a short wait, so the public
   * feed shows real approvals. Only for the demo job; clearly labelled in the demo.
   */
  readonly approver?: {
    readonly apiUrl: string;
    readonly key: string;
    readonly privateKey: string;
    readonly afterMs: number;
  };
  readonly now?: () => Date;
}

const CURSOR = "demo-brief";

/**
 * On-demand mode: moves the demo job to its next scene when a visitor has clicked "Run a scene".
 * Nothing runs without a click. Returns the brief set.
 */
export async function serveDemoClick(deps: DemoDeps): Promise<string | null> {
  if (deps.running.has(deps.jobId)) return null;
  return serveDemoRequest(deps.db, deps.jobId, (deps.now ?? (() => new Date()))());
}

/** Automatic mode: moves the demo job to its next brief when the last run is old enough. Returns the brief set. */
export async function rotateDemoBrief(deps: DemoDeps): Promise<string | null> {
  const now = (deps.now ?? (() => new Date()))();
  if (deps.running.has(deps.jobId)) return null;
  const [job] = await deps.db.select().from(jobs).where(eq(jobs.id, deps.jobId));
  if (job === undefined || job.status !== "ACTIVE" || job.frozenReason !== null) return null;
  // Still waiting for its current brief to run, or ran too recently.
  if (job.operatorRunAt === null) return null;
  if (now.getTime() - job.operatorRunAt.getTime() < deps.intervalMs) return null;

  const [cursor] = await deps.db.select().from(chainCursors).where(eq(chainCursors.name, CURSOR));
  const next = ((cursor?.block ?? -1) + 1) % DEMO_BRIEFS.length;
  const brief = DEMO_BRIEFS[next] as string;
  await deps.db.update(jobs).set({ brief, operatorRunAt: null }).where(eq(jobs.id, deps.jobId));
  await deps.db
    .insert(chainCursors)
    .values({ name: CURSOR, block: next })
    .onConflictDoUpdate({ target: chainCursors.name, set: { block: next, updatedAt: now } });
  log.info("demo: next brief", { jobId: deps.jobId, brief: next });
  return brief;
}

interface Pending {
  authorizationId: string;
  jobId: string;
  requestedAt: string;
  typedData:
    (TypedDataDefinition & { message: { deadline: string; policyVersion: string } }) | null;
}

/** Approves the demo job's waiting payments once they've waited `afterMs`. Returns how many. */
export async function approveDemoPayments(
  deps: DemoDeps,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const a = deps.approver;
  if (a === undefined) return 0;
  const now = (deps.now ?? (() => new Date()))();
  const headers = { authorization: `Bearer ${a.key}`, "content-type": "application/json" };
  const listing = (await (await fetchFn(`${a.apiUrl}/approvals`, { headers })).json()) as {
    pending?: Pending[];
  };
  const wallet = privateKeyToAccount(a.privateKey as Hex);
  let approved = 0;
  for (const item of listing.pending ?? []) {
    if (item.jobId !== deps.jobId || item.typedData === null) continue;
    if (now.getTime() - new Date(item.requestedAt).getTime() < a.afterMs) continue;
    const signature = await wallet.signTypedData(item.typedData);
    const response = await fetchFn(`${a.apiUrl}/approvals/${item.authorizationId}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        verdict: "APPROVE",
        approverAddress: wallet.address,
        signature,
        deadline: Number(item.typedData.message.deadline),
        policyVersion: Number(item.typedData.message.policyVersion),
      }),
    });
    if (response.ok) {
      approved += 1;
      log.info("demo: payment approved", { authorizationId: item.authorizationId });
    } else {
      log.warn("demo: approval refused", {
        authorizationId: item.authorizationId,
        status: response.status,
      });
    }
  }
  return approved;
}
