import type { PendingApproval } from "../lib/api.js";
import { useIsApprover } from "../lib/approve.js";

/** What the Approve button says while the wallet is being asked something. */
export function approveLabel(step: "register" | "sign" | null): string {
  if (step === "register") return "Confirm in wallet (1 of 2)…";
  if (step === "sign") return "Sign in your wallet…";
  return "Approve";
}

/**
 * Said before the first approval on a job, when the wallet isn't registered as an approver yet:
 * the wallet will ask twice (register, then sign), and only this once.
 */
export function FirstApprovalNote({ pending }: { pending: PendingApproval }) {
  if (useIsApprover(pending) !== false) return null;
  return (
    <p className="mt-2 text-xs text-muted">
      First approval on this job: your wallet asks twice, once to allow itself to approve payments
      here, then to sign this one. After that, one signature each.
    </p>
  );
}
