import { createHash, randomBytes } from "node:crypto";

export type Role = "OWNER" | "APPROVER" | "AGENT";

const rolePrefix: Record<Role, string> = { OWNER: "own", APPROVER: "apr", AGENT: "agt" };

export interface IssuedKey {
  /** The secret. Shown to the caller exactly once and never stored. */
  readonly key: string;
  readonly hash: string;
  readonly prefix: string;
}

/** Keys are hashed with SHA-256 before storage; a database leak doesn't leak usable keys. */
export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function issueKey(role: Role): IssuedKey {
  const key = `bsr_${rolePrefix[role]}_${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashKey(key), prefix: key.slice(0, 14) };
}
