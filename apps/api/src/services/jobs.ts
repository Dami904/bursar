import { randomUUID } from "node:crypto";
import { vaultJobIdFor, type WalletProvider } from "@bursar/payments";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@bursar/db";
import { categoryLimits, jobs, payees } from "@bursar/db";
import { badRequest, notFound } from "../http/errors.js";
import { normalizePayee, type PayeeKind } from "./payees.js";

export interface CreateJobInput {
  readonly title: string;
  readonly customer: string;
  readonly budget: bigint;
  readonly perTxCap: bigint;
  readonly approvalThreshold: bigint;
  readonly windowCap: bigint;
  readonly windowSeconds: number;
  readonly expiresAt: Date;
  readonly delegationAllowed: boolean;
  /** What the AI operator should do once the job is live. */
  readonly brief?: string | undefined;
}

/**
 * Creates a job in DRAFT with its own wallet and a derived vault id. It goes ACTIVE only when the
 * indexer sees the owner create and fund it in JobVault.
 */
export async function createJob(
  db: Db,
  ownerId: string,
  input: CreateJobInput,
  wallets?: WalletProvider,
) {
  if (input.perTxCap > input.budget) throw badRequest("perTxCap can't exceed the budget");
  if (input.expiresAt.getTime() <= Date.now()) throw badRequest("expiresAt must be in the future");
  const id = randomUUID();
  const wallet =
    wallets === undefined ? undefined : await wallets.createJobWallet(`bursar-job-${id}`);
  const [job] = await db
    .insert(jobs)
    .values({
      id,
      ownerId,
      ...input,
      brief: input.brief ?? null,
      vaultJobId: vaultJobIdFor(id),
      agentWalletId: wallet?.id ?? null,
      agentWalletAddress: wallet?.address ?? null,
    })
    .returning();
  if (job === undefined) throw new Error("job insert returned nothing");
  return job;
}

export async function getOwnedJob(db: Db, ownerId: string, jobId: string) {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.ownerId, ownerId)))
    .limit(1);
  // Another owner's job is "not found", not "forbidden": don't confirm that it exists.
  if (job === undefined) throw notFound("Job");
  return job;
}

export async function addPayee(
  db: Db,
  ownerId: string,
  jobId: string,
  input: {
    kind: PayeeKind;
    value: string;
    label?: string | undefined;
    category?: string | undefined;
  },
) {
  await getOwnedJob(db, ownerId, jobId);
  const [payee] = await db
    .insert(payees)
    .values({
      jobId,
      kind: input.kind,
      value: normalizePayee(input.kind, input.value),
      label: input.label ?? null,
      category: input.category ?? null,
    })
    .onConflictDoUpdate({
      target: [payees.jobId, payees.kind, payees.value],
      set: { label: input.label ?? null, category: input.category ?? null },
    })
    .returning();
  return payee;
}

export async function setCategoryLimit(
  db: Db,
  ownerId: string,
  jobId: string,
  category: string,
  spendLimit: bigint,
) {
  await getOwnedJob(db, ownerId, jobId);
  const [row] = await db
    .insert(categoryLimits)
    .values({ jobId, category, spendLimit })
    .onConflictDoUpdate({
      target: [categoryLimits.jobId, categoryLimits.category],
      set: { spendLimit },
    })
    .returning();
  return row;
}

/**
 * Chain-driven updates. Only the indexer (day 5) calls these, from JobVault events; the API never
 * lets an owner or agent set them directly.
 */
export async function recordJobCreatedOnChain(db: Db, jobId: string, vaultJobId: string) {
  await db.update(jobs).set({ status: "ACTIVE", vaultJobId }).where(eq(jobs.id, jobId));
}

export async function recordFunding(db: Db, jobId: string, amount: bigint) {
  await db
    .update(jobs)
    .set({ deposited: sql`${jobs.deposited} + ${amount.toString()}::bigint` })
    .where(eq(jobs.id, jobId));
}
