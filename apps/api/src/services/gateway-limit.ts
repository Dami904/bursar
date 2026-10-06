import { formatUsdc } from "@bursar/money";

/**
 * A seller paid through Circle Gateway is funded from a float the vault releases to the job's
 * wallet. The vault only releases up to the job's approval amount without a person's signature on
 * that very transfer, and a person's approval of the payment can't stand in for it. So a price above
 * that amount could be approved and still fail. This says so up front, before anyone is asked.
 * Null when the payment is fine.
 */
export function gatewayAboveApproval(
  rail: string,
  amount: bigint,
  approvalThreshold: bigint,
): string | null {
  if (rail !== "GATEWAY" || amount <= approvalThreshold) return null;
  return `This seller is paid through Circle Gateway, which can't pay more than the job's approval amount (${formatUsdc(approvalThreshold)} USDC), and it asks ${formatUsdc(amount)} USDC. The owner can create a job with a higher "Ask me above" to buy it.`;
}
