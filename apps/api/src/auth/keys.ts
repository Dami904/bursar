// Issuing and hashing live in @bursar/db, so the worker can mint keys for automatic runs too.
export { hashKey, issueKey, type IssuedKey, type Role } from "@bursar/db";

/** Extracts the key from an `Authorization: Bearer <key>` header, or null. */
export function bearerKey(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer (bsr_[a-z]{3}_[A-Za-z0-9_-]{43})$/.exec(header.trim());
  return match?.[1] ?? null;
}
