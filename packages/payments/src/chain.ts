import { keccak256, parseAbi, stringToBytes, type Hex } from "viem";

/** The bytes32 JobVault id for a Bursar job: derived, so the API and indexer always agree. */
export function vaultJobIdFor(jobId: string): Hex {
  return keccak256(stringToBytes(`bursar:job:${jobId}`));
}

/**
 * The bytes32 operation id for an authorization. Deterministic, so a retried release after a crash
 * reuses the same id and JobVault refuses to pay it twice.
 */
export function vaultOpIdFor(authorizationId: string): Hex {
  return keccak256(stringToBytes(`bursar:op:${authorizationId}`));
}

export const jobVaultAbi = parseAbi([
  "function isPayee(bytes32 jobId, address payee) view returns (bool)",
  "function isApprover(bytes32 jobId, address approver) view returns (bool)",
  "struct Approval { address approver; uint64 deadline; bytes signature; }",
  "struct JobParams { address agentWallet; uint128 budget; uint128 perTxCap; uint128 approvalThreshold; uint128 windowCap; uint64 window; uint64 expiry; }",
  "struct Job { address owner; uint8 status; uint64 policyVersion; address agentWallet; uint64 expiry; uint128 budget; uint128 deposited; uint128 spent; uint128 withdrawn; uint128 perTxCap; uint128 approvalThreshold; uint128 windowCap; uint128 windowSpent; uint64 window; uint64 windowStart; }",
  "function createJob(bytes32 jobId, JobParams p)",
  "function fund(bytes32 jobId, uint128 amount)",
  "function setPayee(bytes32 jobId, address payee, bool allowed)",
  "function setApprover(bytes32 jobId, address approver, bool allowed)",
  "function pause(bytes32 jobId)",
  "function unpause(bytes32 jobId)",
  "function closeJob(bytes32 jobId)",
  "function refunded(bytes32 jobId, bytes32 opId) view returns (bool)",
  "function release(bytes32 jobId, bytes32 opId, address to, uint128 amount, uint64 expectedPolicyVersion, Approval approval)",
  "function refund(bytes32 jobId, bytes32 opId, uint128 amount)",
  "function getJob(bytes32 jobId) view returns (Job)",
  "function releasedFor(bytes32 jobId, bytes32 opId) view returns (uint128)",
  "function available(bytes32 jobId) view returns (uint128)",
  "event JobCreated(bytes32 indexed jobId, address indexed owner, JobParams params)",
  "event Funded(bytes32 indexed jobId, address indexed from, uint256 amount)",
  "event Released(bytes32 indexed jobId, bytes32 indexed opId, address indexed to, uint128 amount, bool approved)",
  "event Refunded(bytes32 indexed jobId, bytes32 indexed opId, uint128 amount)",
  "event BudgetChanged(bytes32 indexed jobId, uint128 budget, uint64 policyVersion)",
  "event LimitsChanged(bytes32 indexed jobId, uint128 perTxCap, uint128 approvalThreshold, uint128 windowCap, uint64 window, uint64 policyVersion)",
  "event PayeeChanged(bytes32 indexed jobId, address indexed payee, bool allowed, uint64 policyVersion)",
  "event ApproverChanged(bytes32 indexed jobId, address indexed approver, bool allowed, uint64 policyVersion)",
  "event StatusChanged(bytes32 indexed jobId, uint8 status, uint64 policyVersion)",
  "event Withdrawn(bytes32 indexed jobId, address indexed to, uint256 amount)",
  "error NotOperator()",
  "error NotOwner()",
  "error JobExists()",
  "error InvalidParams()",
  "error JobNotActive()",
  "error JobClosed()",
  "error JobExpired()",
  "error ZeroAmount()",
  "error PayeeNotAllowed()",
  "error PerTxCapExceeded()",
  "error BudgetExceeded()",
  "error Underfunded()",
  "error RateLimited()",
  "error OpAlreadyUsed()",
  "error StalePolicy(uint64 current, uint64 expected)",
  "error ApprovalRequired()",
  "error BadApproval()",
  "error NotReleased()",
  "error AlreadyRefunded()",
  "error RefundTooLarge()",
  "error RefundNotReceived()",
]);

export const auditAnchorAbi = parseAbi([
  "function anchor(bytes32 head, uint64 seq, uint64 decisions)",
  "function latestSeq() view returns (uint64)",
  "function anchors(uint64 seq) view returns (bytes32 head, uint64 decisions, uint64 timestamp)",
  "function operator() view returns (address)",
  "event Anchored(uint64 indexed seq, bytes32 head, uint64 decisions, uint64 timestamp)",
  "error NotOperator()",
  "error BadSequence(uint64 expected, uint64 got)",
  "error DecisionsWentBackwards()",
]);

export const usdcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  /** EIP-3009: true once a signed authorization's nonce has been used. */
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

/** JobVault's Status enum. */
export const vaultStatus = { 0: "NONE", 1: "ACTIVE", 2: "PAUSED", 3: "CLOSED" } as const;
