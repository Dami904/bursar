import { createHash } from "node:crypto";
import { and, asc, desc, gt, inArray, lte, sql } from "drizzle-orm";
import type { Db, Tx } from "./client.js";
import { auditChain, authorizations, decisions } from "./schema.js";

/**
 * The hash-chained audit log (PLAN.md G5).
 *
 *   payloadHash = sha256(canonicalJson(payload))
 *   hash        = sha256(prevHash ‖ seq as 8 bytes big-endian ‖ payloadHash)
 *
 * SHA-256 and a fixed byte layout, so anyone (the console, in a browser) can recompute the chain
 * and compare it with the head anchored on Arc.
 */

export const GENESIS_HASH = `0x${"0".repeat(64)}`;

/** Any fixed number: appends take this transaction lock, so seqs are gapless and in order. */
const AUDIT_LOCK = 4_242_002;

type Row = typeof auditChain.$inferSelect;
type DecisionRow = typeof decisions.$inferSelect;

/** JSON with sorted keys, bigints as strings and dates as ISO strings: one text per value. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(data: string | Buffer): string {
  return `0x${createHash("sha256").update(data).digest("hex")}`;
}

export function payloadHashOf(payload: unknown): string {
  return sha256(canonicalJson(payload));
}

export function entryHash(prevHash: string, seq: number, payloadHash: string): string {
  const seqBytes = Buffer.alloc(8);
  seqBytes.writeBigUInt64BE(BigInt(seq));
  return sha256(
    Buffer.concat([
      Buffer.from(prevHash.slice(2), "hex"),
      seqBytes,
      Buffer.from(payloadHash.slice(2), "hex"),
    ]),
  );
}

/** What a purchase sends to its seller: the URL, and for a POST, the JSON body. */
export interface SellerRequestRecord {
  readonly url: string;
  readonly method?: string | undefined;
  readonly body?: string | undefined;
}

/** The hash a quoted purchase's decision carries, so the log covers the exact request paid for. */
export function requestHashOf(request: SellerRequestRecord): string {
  return payloadHashOf({
    url: request.url,
    method: request.method ?? "GET",
    body: request.body ?? null,
  });
}

/** The request a stored authorization will send: its URL plus the request kept with the quote. */
export function storedRequestOf(auth: {
  paymentUrl: string | null;
  paymentRequirements: unknown;
}): SellerRequestRecord | null {
  if (auth.paymentUrl === null) return null;
  const request = (
    auth.paymentRequirements as { request?: { method?: string; body?: string } } | null
  )?.request;
  return { url: auth.paymentUrl, method: request?.method, body: request?.body };
}

/** What a decision contributes to the log. Rebuilt from the row when verifying, so edits show. */
export function decisionPayload(d: DecisionRow) {
  return {
    id: d.id,
    jobId: d.jobId,
    agentId: d.agentId,
    operationId: d.operationId,
    kind: d.kind,
    payee: d.payee,
    amount: d.amount,
    category: d.category,
    invoiceRef: d.invoiceRef,
    reasoning: d.reasoning,
    result: d.result,
    reason: d.reason,
    checks: d.checks,
    remainingAtDecision: d.remainingAtDecision,
    policyVersion: d.policyVersion,
    // Only on decisions made since it existed: left out (not null) otherwise, so older entries
    // rebuild to exactly what was hashed.
    requestHash: d.requestHash ?? undefined,
    createdAt: d.createdAt,
  };
}

export interface AuditEntryInput {
  readonly jobId: string | null;
  readonly event: "decision" | "transition";
  readonly refId: string;
  readonly payload: unknown;
}

/**
 * Appends one entry inside the caller's transaction, so the entry commits (or rolls back) with the
 * change it describes. Callers take their job's row lock first and this lock after it, always in
 * that order, so the two can't deadlock.
 */
export async function appendAudit(tx: Tx, input: AuditEntryInput): Promise<Row> {
  await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_LOCK})`);
  const [last] = await tx
    .select({ seq: auditChain.seq, hash: auditChain.hash })
    .from(auditChain)
    .orderBy(desc(auditChain.seq))
    .limit(1);
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? GENESIS_HASH;
  // Stored exactly as it will be read back (jsonb), so verifying hashes the same value.
  const payload = JSON.parse(canonicalJson(input.payload)) as unknown;
  const payloadHash = payloadHashOf(payload);
  const [row] = await tx
    .insert(auditChain)
    .values({
      seq,
      jobId: input.jobId,
      event: input.event,
      refId: input.refId,
      payload,
      payloadHash,
      prevHash,
      hash: entryHash(prevHash, seq, payloadHash),
    })
    .returning();
  if (row === undefined) throw new Error("audit insert returned nothing");
  return row;
}

export interface ChainCheck {
  readonly ok: boolean;
  /** Entries that checked out. */
  readonly checked: number;
  /** The hash after the last good entry: the value to compare with an anchor. */
  readonly head: string;
  readonly headSeq: number;
  readonly problem: { readonly seq: number; readonly problem: string } | null;
}

/**
 * Recomputes the chain from the start, entry by entry, and checks each decision entry against the
 * decision row as it stands now. Stops at the first problem. `upTo` limits it to a prefix, for
 * comparing with an older anchor.
 */
export async function verifyChain(db: Db, upTo?: number): Promise<ChainCheck> {
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  const fail = (seq: number, problem: string): ChainCheck => ({
    ok: false,
    checked: expectedSeq - 1,
    head: prev,
    headSeq: expectedSeq - 1,
    problem: { seq, problem },
  });
  for (;;) {
    const after = gt(auditChain.seq, expectedSeq - 1);
    const batch = await db
      .select()
      .from(auditChain)
      .where(upTo === undefined ? after : and(after, lte(auditChain.seq, upTo)))
      .orderBy(asc(auditChain.seq))
      .limit(1000);
    if (batch.length === 0) break;
    const decisionIds = batch.filter((e) => e.event === "decision").map((e) => e.refId);
    const rows =
      decisionIds.length === 0
        ? []
        : await db.select().from(decisions).where(inArray(decisions.id, decisionIds));
    const byId = new Map(rows.map((d) => [d.id, d]));
    // A purchase's stored request must still be the one its decision hashed.
    const hashed = rows.filter((d) => d.requestHash !== null).map((d) => d.id);
    const auths =
      hashed.length === 0
        ? []
        : await db
            .select({
              decisionId: authorizations.decisionId,
              paymentUrl: authorizations.paymentUrl,
              paymentRequirements: authorizations.paymentRequirements,
            })
            .from(authorizations)
            .where(inArray(authorizations.decisionId, hashed));
    const authByDecision = new Map(auths.map((a) => [a.decisionId, a]));
    for (const entry of batch) {
      if (entry.seq !== expectedSeq) return fail(expectedSeq, "an entry is missing");
      if (entry.prevHash !== prev) return fail(entry.seq, "it doesn't link to the entry before");
      const payloadHash = payloadHashOf(entry.payload);
      if (payloadHash !== entry.payloadHash) return fail(entry.seq, "its payload was changed");
      if (entryHash(prev, entry.seq, payloadHash) !== entry.hash) {
        return fail(entry.seq, "its hash is wrong");
      }
      if (entry.event === "decision") {
        const row = byId.get(entry.refId);
        if (row === undefined) return fail(entry.seq, "the decision it records was deleted");
        if (payloadHashOf(JSON.parse(canonicalJson(decisionPayload(row)))) !== payloadHash) {
          return fail(entry.seq, "the decision it records was edited");
        }
        const auth = authByDecision.get(row.id);
        const stored = auth === undefined ? null : storedRequestOf(auth);
        if (
          row.requestHash !== null &&
          stored !== null &&
          requestHashOf(stored) !== row.requestHash
        ) {
          return fail(entry.seq, "the request it paid for was edited");
        }
      }
      prev = entry.hash;
      expectedSeq += 1;
    }
  }
  if (upTo !== undefined && expectedSeq - 1 < upTo) {
    return fail(expectedSeq, "the log ends before the anchored entry");
  }
  return {
    ok: true,
    checked: expectedSeq - 1,
    head: prev,
    headSeq: expectedSeq - 1,
    problem: null,
  };
}

/** The latest entry, or null for an empty log. */
export async function auditHead(db: Db): Promise<{ seq: number; hash: string } | null> {
  const [last] = await db
    .select({ seq: auditChain.seq, hash: auditChain.hash })
    .from(auditChain)
    .orderBy(desc(auditChain.seq))
    .limit(1);
  return last ?? null;
}

/** Appends every decision the log doesn't have yet: those made before the log existed. */
export async function backfillDecisions(db: Db): Promise<number> {
  const missing = await db
    .select()
    .from(decisions)
    .where(
      sql`not exists (select 1 from audit_chain a where a.event = 'decision' and a.ref_id = ${decisions.id})`,
    )
    .orderBy(asc(decisions.createdAt));
  for (const d of missing) {
    await db.transaction((tx) =>
      appendAudit(tx, {
        jobId: d.jobId,
        event: "decision",
        refId: d.id,
        payload: decisionPayload(d),
      }),
    );
  }
  return missing.length;
}
