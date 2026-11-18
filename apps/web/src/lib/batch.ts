import { jobVaultAbi, usdcAbi } from "@bursar/payments/chain";
import { encodeFunctionData, type Hex } from "viem";

/**
 * EXPERIMENT, off unless the build sets VITE_BATCH_SETUP=true.
 *
 * Some wallets can run several calls as one all-or-nothing bundle behind a single confirmation
 * (EIP-5792). For job setup that turns "open, allow, deposit" into one prompt. The catch (see
 * contracts/test/JobVault.delegation.t.sol): many wallets get there by upgrading the owner's plain
 * address (EIP-7702), and an upgraded address has code, so the vault then asks that code to vouch
 * for the owner's approval signatures. A delegate that doesn't vouch makes every later approval
 * fail. That's why this is a switch, and why a wallet should only be trusted after the testnet
 * check in docs/spikes/batch-setup.md.
 */

export interface BatchCall {
  to: Hex;
  data: Hex;
}

/** Whether the wallet says it can run a bundle all-or-nothing on this chain. */
export function supportsAtomicBatch(capabilities: unknown, chainId: number): boolean {
  if (typeof capabilities !== "object" || capabilities === null) return false;
  const entry = (capabilities as Record<number, { atomic?: { status?: unknown } } | undefined>)[
    chainId
  ];
  const status = entry?.atomic?.status;
  return status === "supported" || status === "ready";
}

/** The rules a job is opened with in the vault, from the job as Bursar has it. */
export interface OnChainParams {
  agentWallet: Hex;
  budget: bigint;
  perTxCap: bigint;
  approvalThreshold: bigint;
  windowCap: bigint;
  window: bigint;
  expiry: bigint;
}

/** The delegate an upgraded address points at, or null for a plain address (no code). */
export function delegatedTo(code: Hex | undefined): Hex | null {
  if (code === undefined || !/^0xef0100[0-9a-fA-F]{40}$/.test(code)) return null;
  return `0x${code.slice(8)}`;
}

/**
 * Every call of a job's setup, in order, for one bundle: open the job, allow exactly the deposit
 * (skipped when the wallet already allows at least that), deposit, and, when a payment can need
 * the owner's approval, register the owner as approver. Vendor addresses are allowed last.
 */
export function buildSetupBatch(input: {
  vault: Hex;
  usdc: Hex;
  vaultJobId: Hex;
  params: OnChainParams;
  allowance: bigint;
  owner: Hex;
  registerApprover: boolean;
  vendors: readonly Hex[];
}): BatchCall[] {
  const { vault, usdc, vaultJobId, params } = input;
  const calls: BatchCall[] = [
    {
      to: vault,
      data: encodeFunctionData({
        abi: jobVaultAbi,
        functionName: "createJob",
        args: [vaultJobId, params],
      }),
    },
  ];
  if (input.allowance < params.budget) {
    calls.push({
      to: usdc,
      data: encodeFunctionData({
        abi: usdcAbi,
        functionName: "approve",
        args: [vault, params.budget],
      }),
    });
  }
  calls.push({
    to: vault,
    data: encodeFunctionData({
      abi: jobVaultAbi,
      functionName: "fund",
      args: [vaultJobId, params.budget],
    }),
  });
  if (input.registerApprover) {
    calls.push({
      to: vault,
      data: encodeFunctionData({
        abi: jobVaultAbi,
        functionName: "setApprover",
        args: [vaultJobId, input.owner, true],
      }),
    });
  }
  for (const vendor of input.vendors) {
    calls.push({
      to: vault,
      data: encodeFunctionData({
        abi: jobVaultAbi,
        functionName: "setPayee",
        args: [vaultJobId, vendor, true],
      }),
    });
  }
  return calls;
}
