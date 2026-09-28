import type { Hex } from "viem";

export interface ApprovalFields {
  readonly chainId: number;
  readonly vault: Hex;
  readonly vaultJobId: Hex;
  readonly opId: Hex;
  /** Where the release pays: the job wallet for x402 purchases. */
  readonly to: Hex;
  readonly amount: bigint;
  /** The job's on-chain rules version at signing time. A later rule change voids the approval. */
  readonly policyVersion: number;
  /** Unix seconds; JobVault rejects the approval after this. */
  readonly deadline: number;
}

/**
 * The exact EIP-712 message JobVault verifies for a release above the approval threshold
 * (APPROVAL_TYPEHASH in JobVault.sol). Wallets sign this; the API verifies it before the worker
 * passes it to `release`.
 */
export function approvalTypedData(f: ApprovalFields) {
  return {
    domain: {
      name: "Bursar JobVault",
      version: "1",
      chainId: f.chainId,
      verifyingContract: f.vault,
    },
    types: {
      Approval: [
        { name: "jobId", type: "bytes32" },
        { name: "opId", type: "bytes32" },
        { name: "to", type: "address" },
        { name: "amount", type: "uint128" },
        { name: "policyVersion", type: "uint64" },
        { name: "deadline", type: "uint64" },
      ],
    },
    primaryType: "Approval",
    message: {
      jobId: f.vaultJobId,
      opId: f.opId,
      to: f.to,
      amount: f.amount,
      policyVersion: BigInt(f.policyVersion),
      deadline: BigInt(f.deadline),
    },
  } as const;
}
