import { approvers, credentials, owners, siweNonces, type Db } from "@bursar/db";
import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { getAddress, verifyMessage, type Hex } from "viem";
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { issueKey } from "../auth/keys.js";
import { badRequest, unauthorized } from "../http/errors.js";

/** How long a signed-in browser stays signed in. */
export const SESSION_TTL_MS = 24 * 3600 * 1000;
/** How long a nonce can wait for its signature. */
const NONCE_TTL_MS = 10 * 60 * 1000;

export interface SiweConfig {
  /** Hosts the console is served from, e.g. "localhost:5173" or "bursar.vercel.app". */
  readonly domains: readonly string[];
  readonly chainId: number;
}

export async function newNonce(db: Db): Promise<string> {
  const nonce = generateSiweNonce();
  await db.insert(siweNonces).values({ nonce });
  // Housekeeping: nonces older than the window are useless either way.
  await db.delete(siweNonces).where(lt(siweNonces.createdAt, new Date(Date.now() - NONCE_TTL_MS)));
  return nonce;
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Sign-In with Ethereum. The wallet signs a message naming our domain, chain and a one-time nonce;
 * a valid signature proves the caller controls the address, and they get a session key.
 *
 * - A wallet that belongs to an owner signs in as that owner (and is registered as one of the
 *   owner's approvers, so the same wallet can approve payments).
 * - A wallet that is only someone's approver signs in as that approver.
 * - Any other wallet becomes a new owner: signing in is signing up.
 *
 * EOA wallets only for now (the same limit as approval signatures).
 */
export async function signIn(db: Db, config: SiweConfig, message: string, signature: string) {
  let parsed;
  try {
    parsed = parseSiweMessage(message);
  } catch {
    throw badRequest("That isn't a sign-in message");
  }
  const nonce = parsed.nonce;
  if (nonce === undefined || parsed.address === undefined) {
    throw badRequest("That isn't a sign-in message");
  }
  const domainOk = config.domains.some((domain) =>
    validateSiweMessage({ message: parsed, domain, nonce }),
  );
  if (!domainOk || parsed.chainId !== config.chainId) {
    throw unauthorized("This sign-in message isn't for this site or network");
  }
  const valid = await verifyMessage({
    address: parsed.address,
    message,
    signature: signature as Hex,
  }).catch(() => false);
  if (!valid) throw unauthorized("The signature doesn't match the wallet");

  // Spend the nonce: it works once, and only while fresh.
  const [spent] = await db
    .update(siweNonces)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(siweNonces.nonce, nonce),
        isNull(siweNonces.usedAt),
        gt(siweNonces.createdAt, new Date(Date.now() - NONCE_TTL_MS)),
      ),
    )
    .returning();
  if (spent === undefined) throw unauthorized("This sign-in request expired; try again");

  const wallet = getAddress(parsed.address).toLowerCase();
  return db.transaction(async (tx) => {
    let [owner] = await tx.select().from(owners).where(eq(owners.walletAddress, wallet));
    let role: "OWNER" | "APPROVER" = "OWNER";
    let ownerId: string;
    if (owner !== undefined) {
      ownerId = owner.id;
    } else {
      const [approverOf] = await tx
        .select()
        .from(approvers)
        .where(eq(approvers.walletAddress, wallet))
        .orderBy(desc(approvers.createdAt))
        .limit(1);
      if (approverOf !== undefined) {
        role = "APPROVER";
        ownerId = approverOf.ownerId;
      } else {
        [owner] = await tx
          .insert(owners)
          .values({ name: shortAddress(getAddress(wallet)), walletAddress: wallet })
          .returning();
        if (owner === undefined) throw new Error("owner insert returned nothing");
        ownerId = owner.id;
      }
    }
    if (role === "OWNER") {
      // The owner's own wallet can always approve their payments (the vault must also allow it).
      await tx
        .insert(approvers)
        .values({ ownerId, name: "You", walletAddress: wallet })
        .onConflictDoNothing();
    }
    const issued = issueKey(role);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await tx.insert(credentials).values({
      keyHash: issued.hash,
      keyPrefix: issued.prefix,
      role,
      ownerId,
      expiresAt,
    });
    return {
      key: issued.key,
      role,
      wallet: getAddress(wallet),
      ownerId,
      ownerName: owner?.name ?? null,
      expiresAt: expiresAt.toISOString(),
    };
  });
}

/** Ends a session: its key stops working at once. */
export async function signOut(db: Db, credentialId: string) {
  await db
    .update(credentials)
    .set({ revokedAt: new Date() })
    .where(and(eq(credentials.id, credentialId), isNull(credentials.revokedAt)));
}
