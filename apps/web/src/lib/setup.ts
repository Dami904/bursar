import { parseUsdc } from "@bursar/money";

/**
 * Setting up a job asks the owner's wallet for as few confirmations as it safely can: never more
 * than three. Open the job, allow the exact deposit, deposit. The allow step is skipped when the
 * wallet already allows at least this deposit. Registering the owner's wallet as an approver, and
 * allowing vendor addresses, happen later, at the moment they're first needed.
 */
export const MAX_SETUP_CONFIRMATIONS = 3;

export interface SetupStep {
  id: "create" | "vault" | "approve" | "fund" | "live";
  label: string;
  why: string;
  /** True when the wallet has to confirm this step. */
  signs: boolean;
}

/**
 * The steps to set up a job, in order.
 * `allowance` is what the wallet already lets the vault take (undefined while it's unknown: the
 * step is then shown, and skipped later if the wallet turns out to allow enough).
 */
export function planSetup(input: {
  budget: string;
  amount: bigint;
  allowance: bigint | undefined;
}): SetupStep[] {
  const steps: SetupStep[] = [
    {
      id: "create",
      label: "Create the job",
      why: "Saved in Bursar. Nothing is signed.",
      signs: false,
    },
    {
      id: "vault",
      label: "Open it in the vault",
      why: "Registers the job's rules on Arc.",
      signs: true,
    },
  ];
  if (input.allowance === undefined || input.allowance < input.amount) {
    steps.push({
      id: "approve",
      label: "Allow the deposit",
      why: `Lets the vault take exactly ${input.budget} USDC from your wallet, once. No money moves yet.`,
      signs: true,
    });
  }
  steps.push(
    {
      id: "fund",
      label: `Deposit ${input.budget} USDC`,
      why: "Moves it into the vault. It stays yours: agents can only spend within your rules.",
      signs: true,
    },
    {
      id: "live",
      label: "Waiting for Arc",
      why: "Arc confirms it, usually in under a minute.",
      signs: false,
    },
  );
  return steps;
}

export const confirmationsOf = (steps: readonly SetupStep[]) =>
  steps.filter((s) => s.signs).length;

/**
 * Whether any payment on this job can need an owner's approval: only when the approval threshold
 * is below the per-payment cap. A job with no way to need one never asks the owner to register
 * their wallet as an approver.
 */
export function approvalsPossible(job: { approvalThreshold: string; perTxCap: string }): boolean {
  return parseUsdc(job.approvalThreshold) < parseUsdc(job.perTxCap);
}

/** What the first approval on a job asks of the wallet, in order. */
export function approvalConfirmations(alreadyRegistered: boolean): string[] {
  return alreadyRegistered
    ? ["Approve this payment"]
    : ["Let your wallet approve payments on this job (once)", "Approve this payment"];
}
