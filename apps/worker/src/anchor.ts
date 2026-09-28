import { auditAnchors, verifyChain, type Db } from "@bursar/db";
import { auditAnchorAbi } from "@bursar/payments";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type { Account, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";
import { revertReason } from "./executor.js";
import { log } from "./log.js";

export interface AnchorDeps {
  readonly db: Db;
  readonly client: PublicClient;
  readonly operator: WalletClient<Transport, Chain, Account>;
  readonly anchor: Hex;
  /** Anchor at least this often when there's anything new… */
  readonly intervalMs: number;
  /** …or as soon as this many entries are waiting. */
  readonly everyEntries: number;
  readonly receiptTimeoutMs?: number;
}

/** A sent anchor with no receipt after this long is given up on (a later one covers it). */
const GIVE_UP_AFTER_MS = 120_000;

type AnchorRow = typeof auditAnchors.$inferSelect;

/**
 * Posts the audit log's head to AuditAnchor on Arc when it's due. The chain is the source of
 * truth: an anchor counts as confirmed only when `anchors(seq)` on-chain holds our head. The log
 * is verified end to end before anything is posted, so a broken chain is never anchored.
 * Returns the confirmed or newly sent anchor, if any.
 */
export async function anchorOnce(deps: AnchorDeps): Promise<AnchorRow | null> {
  const latestSeq = Number(
    await deps.client.readContract({
      address: deps.anchor,
      abi: auditAnchorAbi,
      functionName: "latestSeq",
    }),
  );
  await syncWithChain(deps, latestSeq);

  const [pending] = await deps.db
    .select()
    .from(auditAnchors)
    .where(eq(auditAnchors.status, "SENT"))
    .orderBy(desc(auditAnchors.sentAt))
    .limit(1);
  if (pending !== undefined) {
    if (Date.now() - pending.sentAt.getTime() < GIVE_UP_AFTER_MS) return null;
    await deps.db
      .update(auditAnchors)
      .set({ status: "FAILED", error: "No receipt in time; a later anchor covers it" })
      .where(eq(auditAnchors.id, pending.id));
  }

  const [last] = await deps.db
    .select()
    .from(auditAnchors)
    .where(eq(auditAnchors.status, "CONFIRMED"))
    .orderBy(desc(auditAnchors.anchorSeq))
    .limit(1);

  const check = await verifyChain(deps.db);
  if (!check.ok) {
    log.error("audit log failed verification: not anchoring it", undefined, {
      problem: check.problem,
      alert: true,
    });
    return null;
  }
  const waiting = check.headSeq - (last?.chainSeq ?? 0);
  if (waiting <= 0) return null;
  const overdue = last === undefined || Date.now() - last.sentAt.getTime() >= deps.intervalMs;
  if (waiting < deps.everyEntries && !overdue) return null;

  const seq = latestSeq + 1;
  const args = [check.head as Hex, BigInt(seq), BigInt(check.headSeq)] as const;
  try {
    await deps.client.simulateContract({
      address: deps.anchor,
      abi: auditAnchorAbi,
      functionName: "anchor",
      args,
      account: deps.operator.account,
    });
  } catch (error) {
    const reason = revertReason(error);
    if (reason === null) throw error; // RPC trouble: try again next tick
    log.error("AuditAnchor refused the anchor", undefined, { reason, seq, alert: true });
    return null;
  }
  const hash = await deps.operator.writeContract({
    address: deps.anchor,
    abi: auditAnchorAbi,
    functionName: "anchor",
    args,
  });
  const [row] = await deps.db
    .insert(auditAnchors)
    .values({
      anchorSeq: seq,
      chainSeq: check.headSeq,
      head: check.head,
      status: "SENT",
      txHash: hash,
    })
    .returning();
  if (row === undefined) throw new Error("anchor insert returned nothing");
  log.info("audit head anchored", { seq, chainSeq: check.headSeq, head: check.head, tx: hash });
  const receipt = await deps.client
    .waitForTransactionReceipt({ hash, timeout: deps.receiptTimeoutMs ?? 30_000 })
    .catch(() => null);
  if (receipt?.status === "reverted") {
    await deps.db
      .update(auditAnchors)
      .set({ status: "FAILED", error: "The anchor transaction reverted" })
      .where(eq(auditAnchors.id, row.id));
    return null;
  }
  if (receipt?.status === "success") await syncWithChain(deps, seq);
  const [fresh] = await deps.db.select().from(auditAnchors).where(eq(auditAnchors.id, row.id));
  return fresh ?? null;
}

/**
 * Marks our sent (or given-up) anchors confirmed when the chain holds exactly our head at their
 * sequence number, and failed when it holds something else there.
 */
async function syncWithChain(deps: AnchorDeps, latestSeq: number): Promise<void> {
  const open = await deps.db
    .select()
    .from(auditAnchors)
    .where(
      and(inArray(auditAnchors.status, ["SENT", "FAILED"]), lte(auditAnchors.anchorSeq, latestSeq)),
    )
    .orderBy(desc(auditAnchors.sentAt))
    .limit(20);
  for (const row of open) {
    const [head] = await deps.client.readContract({
      address: deps.anchor,
      abi: auditAnchorAbi,
      functionName: "anchors",
      args: [BigInt(row.anchorSeq)],
    });
    const [already] = await deps.db
      .select({ id: auditAnchors.id })
      .from(auditAnchors)
      .where(and(eq(auditAnchors.anchorSeq, row.anchorSeq), eq(auditAnchors.status, "CONFIRMED")));
    if (head.toLowerCase() === row.head.toLowerCase() && already === undefined) {
      await deps.db
        .update(auditAnchors)
        .set({ status: "CONFIRMED", error: null, confirmedAt: new Date() })
        .where(eq(auditAnchors.id, row.id));
    } else if (row.status === "SENT") {
      await deps.db
        .update(auditAnchors)
        .set({ status: "FAILED", error: "Another head was anchored at this sequence number" })
        .where(eq(auditAnchors.id, row.id));
    }
  }
}
