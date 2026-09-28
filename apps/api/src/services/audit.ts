import { auditAnchors, auditChain, verifyChain, type Db } from "@bursar/db";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { getOwnedJob } from "./jobs.js";

type AnchorRow = typeof auditAnchors.$inferSelect;

function anchorView(anchor: AnchorRow) {
  return {
    anchorSeq: anchor.anchorSeq,
    coversUpTo: anchor.chainSeq,
    head: anchor.head,
    txHash: anchor.txHash,
    anchoredAt: (anchor.confirmedAt ?? anchor.sentAt).toISOString(),
  };
}

/**
 * One job's entries in the audit log, oldest first, each with the first on-chain anchor that
 * covers it (null until the next anchor). Only the job's owner sees payloads.
 */
export async function jobAuditTrail(db: Db, ownerId: string, jobId: string, limit = 500) {
  const job = await getOwnedJob(db, ownerId, jobId);
  const entries = await db
    .select()
    .from(auditChain)
    .where(eq(auditChain.jobId, job.id))
    .orderBy(asc(auditChain.seq))
    .limit(limit);
  const anchors = await db
    .select()
    .from(auditAnchors)
    .where(
      and(
        eq(auditAnchors.status, "CONFIRMED"),
        gte(auditAnchors.chainSeq, entries[0]?.seq ?? Number.MAX_SAFE_INTEGER),
      ),
    )
    .orderBy(asc(auditAnchors.chainSeq));
  return entries.map((e) => {
    const anchor = anchors.find((a) => a.chainSeq >= e.seq);
    return {
      seq: e.seq,
      event: e.event,
      refId: e.refId,
      payload: e.payload,
      payloadHash: e.payloadHash,
      prevHash: e.prevHash,
      hash: e.hash,
      at: e.createdAt.toISOString(),
      anchor: anchor === undefined ? null : anchorView(anchor),
    };
  });
}

/**
 * Recomputes the whole log and checks it against the latest on-chain anchor: the log must
 * reproduce exactly the head that was anchored at that point. Reveals no other business's data.
 */
export async function auditStatus(db: Db) {
  const check = await verifyChain(db);
  const [latest] = await db
    .select()
    .from(auditAnchors)
    .where(eq(auditAnchors.status, "CONFIRMED"))
    .orderBy(desc(auditAnchors.anchorSeq))
    .limit(1);
  let matchesAnchor: boolean | null = null;
  if (latest !== undefined) {
    const prefix =
      latest.chainSeq === check.headSeq ? check : await verifyChain(db, latest.chainSeq);
    matchesAnchor = prefix.ok && prefix.head === latest.head;
  }
  return {
    ok: check.ok && matchesAnchor !== false,
    entries: check.headSeq,
    head: check.head,
    problem: check.problem,
    latestAnchor: latest === undefined ? null : anchorView(latest),
    matchesAnchor,
  };
}
