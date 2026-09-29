import { formatUsdc } from "@bursar/money";
import { gatewayFloatFree } from "@bursar/db";
import type { agents, authorizations, decisions, jobs } from "@bursar/db";
import { committedOf } from "../services/spend.js";

/** Amounts leave the API as decimal USDC strings ("0.40"), never as JS numbers. */
const usdc = (units: bigint) => formatUsdc(units);

export function jobView(job: typeof jobs.$inferSelect) {
  return {
    id: job.id,
    title: job.title,
    customer: job.customer,
    status: job.status,
    budget: usdc(job.budget),
    deposited: usdc(job.deposited),
    settled: usdc(job.settled),
    reserved: usdc(job.reserved),
    pendingApproval: usdc(job.pending),
    unresolved: usdc(job.unresolved),
    remaining: usdc(job.budget - committedOf(job)),
    revenueReceived: usdc(job.revenueReceived),
    /** Model spend (USD, 1:1 with USDC) charged to the job by the AI operator. */
    aiCost: usdc(job.llmCostMicros),
    /** Revenue minus what was paid out minus AI cost. */
    profit: usdc(job.revenueReceived - job.settled - job.llmCostMicros),
    perTxCap: usdc(job.perTxCap),
    approvalThreshold: usdc(job.approvalThreshold),
    windowCap: usdc(job.windowCap),
    windowSeconds: job.windowSeconds,
    expiresAt: job.expiresAt.toISOString(),
    delegationAllowed: job.delegationAllowed,
    frozenReason: job.frozenReason,
    brief: job.brief,
    operatorRunAt: job.operatorRunAt?.toISOString() ?? null,
    /** Circle Gateway float for nano payments: moved out of the vault, then drawn on per call. */
    gateway: {
      funded: usdc(job.gatewayFunded),
      drawn: usdc(job.gatewayDrawn),
      available: usdc(gatewayFloatFree(job)),
      /** Unspent float given back to the owner from Gateway after the job closed. */
      returned: usdc(job.gatewayReturned),
    },
    onChain: {
      vaultJobId: job.vaultJobId,
      agentWallet: job.agentWalletAddress,
      policyVersion: job.policyVersion,
    },
  };
}

export function agentView(agent: typeof agents.$inferSelect) {
  return {
    id: agent.id,
    jobId: agent.jobId,
    name: agent.name,
    role: agent.role,
    parentAgentId: agent.parentAgentId,
    replacesAgentId: agent.replacesAgentId,
    replacedByAgentId: agent.replacedByAgentId,
    status: agent.status,
    spendLimit: agent.spendLimit === null ? null : usdc(agent.spendLimit),
    committed: usdc(agent.committed),
  };
}

export function decisionView(
  decision: typeof decisions.$inferSelect,
  authorization: typeof authorizations.$inferSelect | null,
  replayed: boolean,
) {
  return {
    decisionId: decision.id,
    operationId: decision.operationId,
    replayed,
    kind: decision.kind,
    invoiceRef: decision.invoiceRef,
    result: decision.result,
    reason: decision.reason,
    amount: usdc(decision.amount),
    payee: decision.payee,
    category: decision.category,
    remaining: usdc(decision.remainingAtDecision),
    checks: decision.checks,
    authorization:
      authorization === null ? null : { id: authorization.id, state: authorization.state },
  };
}

export function authorizationView(auth: typeof authorizations.$inferSelect) {
  return {
    id: auth.id,
    state: auth.state,
    amount: usdc(auth.amount),
    /** VAULT: released from the vault and paid on-chain. GATEWAY: paid through Circle Gateway. */
    rail: auth.rail,
    paymentUrl: auth.paymentUrl,
    payTo: auth.payTo,
    vaultTx: auth.vaultTx,
    paymentTx: auth.paymentTx,
    gatewayTransferId: auth.gatewayTransferId,
    deliverable: auth.deliverable,
    reason: auth.resolvedReason,
    updatedAt: auth.updatedAt.toISOString(),
  };
}
