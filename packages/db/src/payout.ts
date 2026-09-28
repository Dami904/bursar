import type { authorizations, jobs } from "./schema.js";

type AuthorizationRow = typeof authorizations.$inferSelect;
type JobRow = typeof jobs.$inferSelect;

/**
 * An invoice is paid straight from the vault to the vendor's address; an x402 purchase goes to
 * the job's wallet, which then pays the seller.
 */
export function isInvoice(auth: Pick<AuthorizationRow, "paymentUrl" | "payTo">): boolean {
  return auth.paymentUrl === null && auth.payTo !== null;
}

/**
 * Where the vault sends this payment's money: the address a release names and an approver signs
 * over. Null when there's nowhere to send it yet (the job has no wallet).
 */
export function payoutAddress(
  auth: Pick<AuthorizationRow, "paymentUrl" | "payTo">,
  job: Pick<JobRow, "agentWalletAddress">,
): string | null {
  return isInvoice(auth) ? auth.payTo : job.agentWalletAddress;
}
