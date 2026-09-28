import { inArray, sql } from "drizzle-orm";
import type { Db, Tx } from "./client.js";
import { agents } from "./schema.js";

export interface LineageAgent {
  readonly id: string;
  readonly status: "ACTIVE" | "REVOKED";
  readonly spendLimit: bigint | null;
  readonly committed: bigint;
}

/** Deeper trees than this are refused when spawning; the walk stops here either way. */
export const MAX_AGENT_DEPTH = 32;

/**
 * An agent and its ancestors, nearest first: [self, parent, grandparent, …]. Spending by an agent
 * is counted against every one of them, so a parent's limit covers its whole subtree.
 */
export async function lineage(db: Db | Tx, agentId: string): Promise<LineageAgent[]> {
  const rows = (await db.execute(sql`
    with recursive up(id, parent_agent_id, depth) as (
      select id, parent_agent_id, 0 from agents where id = ${agentId}
      union all
      select a.id, a.parent_agent_id, up.depth + 1
        from agents a join up on a.id = up.parent_agent_id
       where up.depth < ${MAX_AGENT_DEPTH}
    )
    select id, depth from up order by depth`)) as unknown as { id: string; depth: number }[];
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const found = await db
    .select({
      id: agents.id,
      status: agents.status,
      spendLimit: agents.spendLimit,
      committed: agents.committed,
    })
    .from(agents)
    .where(inArray(agents.id, ids));
  const byId = new Map(found.map((a) => [a.id, a]));
  return ids.flatMap((id) => {
    const agent = byId.get(id);
    return agent === undefined ? [] : [agent];
  });
}

/** Adds `amount` (negative to give it back) to the committed total of an agent and its ancestors. */
export async function commitAlongLineage(
  tx: Tx,
  agentId: string,
  amount: bigint,
  chain?: readonly LineageAgent[],
): Promise<void> {
  const ids = (chain ?? (await lineage(tx, agentId))).map((a) => a.id);
  if (ids.length === 0) return;
  await tx
    .update(agents)
    .set({ committed: sql`${agents.committed} + ${amount.toString()}::bigint` })
    .where(inArray(agents.id, ids));
}
