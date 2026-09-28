import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { Db } from "@bursar/db";
import { credentials } from "@bursar/db";
import { hashKey, type Role } from "./keys.js";

/**
 * Who is calling, derived only from their key. Request bodies never carry identity, so an agent
 * can't claim to be another agent, and a revoked key stops working everywhere at once.
 */
export type Principal =
  | { readonly role: "OWNER"; readonly credentialId: string; readonly ownerId: string }
  | { readonly role: "APPROVER"; readonly credentialId: string; readonly ownerId: string }
  | {
      readonly role: "AGENT";
      readonly credentialId: string;
      readonly ownerId: string;
      readonly jobId: string;
      readonly agentId: string;
    };

export type AgentPrincipal = Extract<Principal, { role: "AGENT" }>;

export async function resolvePrincipal(db: Db, key: string): Promise<Principal | null> {
  const [row] = await db
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.keyHash, hashKey(key)),
        isNull(credentials.revokedAt),
        // Wallet sign-in sessions expire; API keys have no expiry.
        or(isNull(credentials.expiresAt), gt(credentials.expiresAt, new Date())),
      ),
    )
    .limit(1);
  if (row === undefined) return null;
  await db.update(credentials).set({ lastUsedAt: new Date() }).where(eq(credentials.id, row.id));
  const role: Role = row.role;
  if (role === "AGENT") {
    if (row.jobId === null || row.agentId === null) return null;
    return {
      role,
      credentialId: row.id,
      ownerId: row.ownerId,
      jobId: row.jobId,
      agentId: row.agentId,
    };
  }
  return { role, credentialId: row.id, ownerId: row.ownerId };
}
