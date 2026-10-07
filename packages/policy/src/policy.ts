/**
 * The spend policy: a pure function from (job, agent, payee, request, now) to a decision.
 *
 * Checks run in a fixed order and the first failure is the denial reason, so every decision is
 * deterministic and explainable. The same order is enforced by JobVault on-chain (PLAN.md §8.1.2,
 * §8.2); shared test vectors keep the two in step.
 */

export type JobStatus = "DRAFT" | "PENDING_CHAIN" | "ACTIVE" | "PAUSED" | "CLOSED";
export type AgentStatus = "ACTIVE" | "REVOKED";

export const denialReasons = [
  "JOB_NOT_ACTIVE",
  "JOB_EXPIRED",
  "AGENT_NOT_IN_JOB",
  "AGENT_REVOKED",
  "INVALID_AMOUNT",
  "PAYEE_NOT_ALLOWED",
  "PER_TX_CAP_EXCEEDED",
  "AGENT_LIMIT_EXCEEDED",
  "CATEGORY_BUDGET_EXCEEDED",
  "JOB_BUDGET_EXCEEDED",
  "JOB_UNDERFUNDED",
  "RATE_LIMITED",
] as const;

export type DenialReason = (typeof denialReasons)[number];

export interface PolicyJob {
  readonly id: string;
  readonly status: JobStatus;
  readonly expiresAt: Date;
  /** Approved budget, micro-USDC. */
  readonly budget: bigint;
  /** USDC actually deposited in the vault for this job. */
  readonly deposited: bigint;
  /** settled + reserved + pending approval + unresolved. */
  readonly committed: bigint;
  readonly perTxCap: bigint;
  /** Amounts strictly above this need a human approval. */
  readonly approvalThreshold: bigint;
  /** Max committed per spending window. */
  readonly windowCap: bigint;
  readonly windowSeconds: number;
  readonly windowStart: Date;
  readonly windowSpent: bigint;
}

export interface PolicyAgent {
  readonly id: string;
  readonly jobId: string;
  readonly status: AgentStatus;
  /** True when any ancestor (the agent that spawned this one, and so on) is revoked. */
  readonly ancestorRevoked: boolean;
  /** Optional sub-limit carved out of the job budget (or out of the parent's limit). */
  readonly limit: bigint | null;
  /** Committed by this agent and every agent below it (all non-released states). */
  readonly committed: bigint;
  /**
   * The limits of this agent's ancestors that have one, each with what its whole subtree has
   * committed. A helper's spending counts against every one of them, so delegating can never
   * create money: a child's limit is carved out of its parent's, not added to it.
   */
  readonly ancestorLimits: readonly AgentLimit[];
}

export interface AgentLimit {
  readonly limit: bigint;
  readonly committed: bigint;
}

export interface PolicyPayee {
  readonly category: string | null;
}

export interface CategoryLimit {
  readonly limit: bigint;
  readonly committed: bigint;
}

export interface PolicyRequest {
  readonly amount: bigint;
}

export interface PolicyInput {
  readonly job: PolicyJob;
  /** The agent resolved from the caller's credential; null if it doesn't exist. */
  readonly agent: PolicyAgent | null;
  /** The allow-listed payee entry; null when the payee isn't on the job's list. */
  readonly payee: PolicyPayee | null;
  /** The limit for the payee's category, if the job sets one. */
  readonly categoryLimit: CategoryLimit | null;
  readonly request: PolicyRequest;
  readonly now: Date;
}

export interface CheckResult {
  readonly check: DenialReason;
  readonly passed: boolean;
}

export type PolicyOutcome =
  | { readonly outcome: "ALLOWED"; readonly checks: readonly CheckResult[] }
  | { readonly outcome: "NEEDS_APPROVAL"; readonly checks: readonly CheckResult[] }
  | {
      readonly outcome: "DENIED";
      readonly reason: DenialReason;
      readonly checks: readonly CheckResult[];
    };

/** The spending window as it stands at `now`: a fixed window that starts again once `windowSeconds` have passed. */
export function currentWindow(
  job: Pick<PolicyJob, "windowSeconds" | "windowStart" | "windowSpent">,
  now: Date,
): { readonly start: Date; readonly spent: bigint } {
  const endsAt = job.windowStart.getTime() + job.windowSeconds * 1000;
  return now.getTime() >= endsAt
    ? { start: now, spent: 0n }
    : { start: job.windowStart, spent: job.windowSpent };
}

const passes: Record<DenialReason, (input: PolicyInput) => boolean> = {
  JOB_NOT_ACTIVE: ({ job }) => job.status === "ACTIVE",
  JOB_EXPIRED: ({ job, now }) => now.getTime() < job.expiresAt.getTime(),
  AGENT_NOT_IN_JOB: ({ job, agent }) => agent !== null && agent.jobId === job.id,
  AGENT_REVOKED: ({ agent }) =>
    agent !== null && agent.status === "ACTIVE" && !agent.ancestorRevoked,
  INVALID_AMOUNT: ({ request }) => request.amount > 0n,
  PAYEE_NOT_ALLOWED: ({ payee }) => payee !== null,
  PER_TX_CAP_EXCEEDED: ({ job, request }) => request.amount <= job.perTxCap,
  AGENT_LIMIT_EXCEEDED: ({ agent, request }) =>
    agent === null ||
    ((agent.limit === null || agent.committed + request.amount <= agent.limit) &&
      agent.ancestorLimits.every((a) => a.committed + request.amount <= a.limit)),
  CATEGORY_BUDGET_EXCEEDED: ({ categoryLimit, request }) =>
    categoryLimit === null || categoryLimit.committed + request.amount <= categoryLimit.limit,
  JOB_BUDGET_EXCEEDED: ({ job, request }) => job.committed + request.amount <= job.budget,
  JOB_UNDERFUNDED: ({ job, request }) => job.committed + request.amount <= job.deposited,
  RATE_LIMITED: ({ job, request, now }) =>
    currentWindow(job, now).spent + request.amount <= job.windowCap,
};

export function evaluatePolicy(input: PolicyInput): PolicyOutcome {
  const checks: CheckResult[] = [];
  for (const check of denialReasons) {
    const passed = passes[check](input);
    checks.push({ check, passed });
    if (!passed) {
      return { outcome: "DENIED", reason: check, checks };
    }
  }
  return input.request.amount > input.job.approvalThreshold
    ? { outcome: "NEEDS_APPROVAL", checks }
    : { outcome: "ALLOWED", checks };
}
