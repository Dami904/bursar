import { issueKey } from "../auth/keys.js";
import type { Db } from "@bursar/db";
import { credentials, owners } from "@bursar/db";

export async function createOwner(db: Db, name: string) {
  const issued = issueKey("OWNER");
  return db.transaction(async (tx) => {
    const [owner] = await tx.insert(owners).values({ name }).returning();
    if (owner === undefined) throw new Error("owner insert returned nothing");
    await tx.insert(credentials).values({
      keyHash: issued.hash,
      keyPrefix: issued.prefix,
      role: "OWNER",
      ownerId: owner.id,
    });
    return { owner, key: issued.key };
  });
}
