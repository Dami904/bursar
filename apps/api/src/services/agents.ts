import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AgentPrincipal } from "../auth/principal.js";
import { issueKey } from "../auth/keys.js";
import type { Db, Tx } from "@bursar/db";
import { MAX_AGENT_DEPTH, agents, credentials, jobs, lineage } from "@bursar/db";
import { badRequest, conflict, notFound } from "../http/errors.js";
import { getOwnedJob } from "./jobs.js";

export interface AgentInput {
  readonly name: string;
  readonly role: string;
  readonly spendLimit?: bigint | undefined;
}

async function insertAgentWithKey(
  tx: Tx,
  ownerId: string,
  jobId: string,
  input: AgentInput,
  parentAgentId: string | null,
  replacesAgentId: string | null = null,
) {
  const [agent] = await tx
    .insert(agents)
    .values({
      jobId,
      name: input.name,
      role: input.role,
      parentAgentId,
      replacesAgentId,
      spendLimit: input.spendLimit ?? null,
    })
    .returning();
  if (agent === undefined) throw new Error("agent insert returned nothing");
  const issued = issueKey("AGENT");
  await tx.insert(credentials).values({
    keyHash: issued.hash,
    keyPrefix: issued.prefix,
    role: "AGENT",
    ownerId,
    jobId,
    agentId: agent.id,
  });
  return { agent, key: issued.key };
}

export async function createAgent(db: Db, ownerId: string, jobId: string, input: AgentInput) {
  const job = await getOwnedJob(db, ownerId, jobId);
  if (input.spendLimit !== undefined && input.spendLimit > job.budget) {
    throw badRequest("An agent's limit can't exceed the job budget");
  }
  return db.transaction((tx) => insertAgentWithKey(tx, ownerId, jobId, input, null));
}

/**
 * An agent spawns a helper on its own job. The child spends from the same job budget (it never
 * gets new money), and if the parent has a limit, the child's limit must fit inside what the
 * parent has left.
 */
export async function spawnSubagent(db: Db, parent: AgentPrincipal, input: AgentInput) {
  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(jobs).where(eq(jobs.id, parent.jobId)).for("update");
    if (job === undefined) throw notFound("Job");
    if (!job.delegationAllowed) {
      throw conflict("DELEGATION_NOT_ALLOWED", "This job doesn't allow sub-agents");
    }
    const chain = await lineage(tx, parent.agentId);
    const self = chain[0];
    if (self === undefined || chain.some((a) => a.status !== "ACTIVE")) {
      throw conflict("AGENT_REVOKED", "A revoked agent can't spawn sub-agents");
    }
    if (chain.length >= MAX_AGENT_DEPTH) {
      throw conflict("DELEGATION_TOO_DEEP", "This agent tree is as deep as Bursar allows");
    }
    // The tightest limit up the tree. The child's limit is carved out of it, never added to it:
    // everything the child spends also counts against each of these limits.
    const headroom = chain.reduce<bigint | null>((min, a) => {
      if (a.spendLimit === null) return min;
      const left = a.spendLimit - a.committed;
      return min === null || left < min ? left : min;
    }, null);
    if (headroom !== null && (input.spendLimit === undefined || input.spendLimit > headroom)) {
      throw badRequest("A sub-agent's limit must fit inside what its parents have left");
    }
    return insertAgentWithKey(tx, parent.ownerId, parent.jobId, input, self.id);
  });
}

/** Revokes an agent, every agent below it, and all their keys, in one transaction. */
export async function revokeAgent(db: Db, ownerId: string, agentId: string) {
  return db.transaction(async (tx) => {
    const agent = await ownedAgent(tx, ownerId, agentId);
    return { revoked: await revokeTree(tx, agent.id) };
  });
}

async function ownedAgent(tx: Tx, ownerId: string, agentId: string) {
  const [agent] = await tx.select().from(agents).where(eq(agents.id, agentId));
  if (agent === undefined) throw notFound("Agent");
  const [job] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.id, agent.jobId), eq(jobs.ownerId, ownerId)));
  if (job === undefined) throw notFound("Agent");
  return agent;
}

/** Revokes an agent, everything below it, and their keys. Returns every id it covered. */
async function revokeTree(tx: Tx, agentId: string): Promise<string[]> {
  const ids = [agentId];
  for (let frontier = [agentId]; frontier.length > 0;) {
    const children = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(inArray(agents.parentAgentId, frontier));
    frontier = children.map((c) => c.id);
    ids.push(...frontier);
  }
  const now = new Date();
  await tx
    .update(agents)
    .set({ status: "REVOKED", revokedAt: now })
    .where(and(inArray(agents.id, ids), isNull(agents.revokedAt)));
  await tx
    .update(credentials)
    .set({ revokedAt: now })
    .where(and(inArray(credentials.agentId, ids), isNull(credentials.revokedAt)));
  return ids;
}

export type Replacer =
  | { readonly kind: "OWNER"; readonly ownerId: string }
  | { readonly kind: "PARENT"; readonly agent: AgentPrincipal };

/**
 * Replaces an agent (stuck, misbehaving, or already revoked) with a fresh one in the same place in
 * the tree. The old agent and everything below it are revoked in the same transaction. The new
 * agent inherits only what the old one had LEFT: what the old subtree already committed stays
 * counted, against both the old agent and every ancestor, so replacing never creates money.
 * Owners can replace any agent on their jobs; an agent can replace its own direct helpers.
 */
export async function replaceAgent(
  db: Db,
  by: Replacer,
  agentId: string,
  input: {
    readonly name: string;
    readonly role?: string | undefined;
    readonly spendLimit?: bigint | undefined;
  },
) {
  return db.transaction(async (tx) => {
    let old;
    let ownerId: string;
    if (by.kind === "OWNER") {
      old = await ownedAgent(tx, by.ownerId, agentId);
      ownerId = by.ownerId;
    } else {
      const [row] = await tx.select().from(agents).where(eq(agents.id, agentId));
      if (row === undefined || row.parentAgentId !== by.agent.agentId) throw notFound("Agent");
      const parentChain = await lineage(tx, by.agent.agentId);
      if (parentChain.some((a) => a.status !== "ACTIVE")) {
        throw conflict("AGENT_REVOKED", "A revoked agent can't replace its helpers");
      }
      old = row;
      ownerId = by.agent.ownerId;
    }
    // Lock the job first, the same order as spending, so the old agent's counters are settled.
    await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, old.jobId)).for("update");
    const [current] = await tx.select().from(agents).where(eq(agents.id, old.id));
    if (current === undefined) throw notFound("Agent");
    if (current.replacedByAgentId !== null) {
      throw conflict("ALREADY_REPLACED", "This agent has already been replaced");
    }

    const left = current.spendLimit === null ? null : current.spendLimit - current.committed;
    if (input.spendLimit !== undefined && left !== null && input.spendLimit > left) {
      throw badRequest("A replacement's limit can't exceed what the old agent had left");
    }
    await revokeTree(tx, current.id);
    const created = await insertAgentWithKey(
      tx,
      ownerId,
      current.jobId,
      {
        name: input.name,
        role: input.role ?? current.role,
        spendLimit: input.spendLimit ?? left ?? undefined,
      },
      current.parentAgentId,
      current.id,
    );
    await tx
      .update(agents)
      .set({ replacedByAgentId: created.agent.id })
      .where(eq(agents.id, current.id));
    return { ...created, replaced: current.id };
  });
}
