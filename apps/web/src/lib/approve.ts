import { jobVaultAbi } from "@bursar/payments/chain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Hex, TypedDataDefinition } from "viem";
import {
  useConnect,
  useConnection,
  useConnectors,
  useReadContract,
  useSignTypedData,
  useSwitchChain,
} from "wagmi";
import { readContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { api, type PendingApproval } from "./api.js";
import { config } from "./config.js";
import { wagmiConfig } from "./wagmi.js";

interface WireTypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** The API sends numbers as strings (JSON has no bigint); the wallet needs them as numbers. */
function revive(wire: WireTypedData): TypedDataDefinition {
  const fields = wire.types[wire.primaryType] ?? [];
  const message: Record<string, unknown> = { ...wire.message };
  for (const field of fields) {
    if (/^u?int\d*$/.test(field.type) && message[field.name] !== undefined) {
      message[field.name] = BigInt(String(message[field.name]));
    }
  }
  return {
    domain: { ...wire.domain, chainId: Number(wire.domain.chainId) },
    types: wire.types,
    primaryType: wire.primaryType,
    message,
  } as unknown as TypedDataDefinition;
}

/** The vault's own id for the job a payment belongs to: it's part of what the wallet signs. */
function vaultJobIdOf(pending: PendingApproval): Hex | null {
  const wire = pending.typedData as WireTypedData | null;
  const id = wire?.message.jobId;
  return typeof id === "string" && /^0x[0-9a-fA-F]{64}$/.test(id) ? (id as Hex) : null;
}

/**
 * Whether this wallet is already allowed to approve payments on the payment's job. Undefined until
 * Arc answers, or when no wallet is connected.
 */
export function useIsApprover(pending: PendingApproval): boolean | undefined {
  const { address } = useConnection();
  const vaultJobId = vaultJobIdOf(pending);
  const read = useReadContract({
    address: config.vault,
    abi: jobVaultAbi,
    functionName: "isApprover",
    args: vaultJobId === null || address === undefined ? undefined : [vaultJobId, address],
    query: { enabled: vaultJobId !== null && address !== undefined },
  });
  return read.data;
}

/**
 * Approve: the wallet signs the exact message JobVault checks (it names the amount and who gets
 * paid), then the API records it and the worker releases the money.
 *
 * The first approval on a job also registers the owner's wallet as an approver on Arc (one extra
 * confirmation, once), because job setup no longer asks for it up front. If the wallet is already
 * registered, approving is a single signature.
 */
export function useApprove() {
  const connection = useConnection();
  const connectors = useConnectors();
  const { mutateAsync: connect } = useConnect();
  const { mutateAsync: signTypedData } = useSignTypedData();
  const { mutateAsync: switchChain } = useSwitchChain();
  const queryClient = useQueryClient();
  /** What the wallet is being asked right now, for the button. */
  const [step, setStep] = useState<"register" | "sign" | null>(null);
  const mutation = useMutation({
    mutationFn: async (pending: PendingApproval) => {
      if (pending.typedData === null) throw new Error("This job isn't live on-chain yet");
      let account = connection.address;
      if (account === undefined) {
        const connector = connectors[0];
        if (connector === undefined) throw new Error("Connect a wallet first");
        account = (await connect({ connector, chainId: config.chain.id })).accounts[0];
      } else if (connection.chainId !== config.chain.id) {
        await switchChain({ chainId: config.chain.id });
      }
      if (account === undefined) throw new Error("Connect a wallet first");
      const typed = revive(pending.typedData as WireTypedData);

      const vaultJobId = vaultJobIdOf(pending);
      if (vaultJobId === null) throw new Error("This approval is missing its job");
      const registered = await readContract(wagmiConfig, {
        address: config.vault,
        abi: jobVaultAbi,
        functionName: "isApprover",
        args: [vaultJobId, account],
      });
      if (!registered) {
        // Only the job's owner can register an approver. Say so before the wallet fails with a
        // revert nobody can read.
        const job = await readContract(wagmiConfig, {
          address: config.vault,
          abi: jobVaultAbi,
          functionName: "getJob",
          args: [vaultJobId],
        });
        if (job.owner.toLowerCase() !== account.toLowerCase()) {
          throw new Error(
            "This wallet isn't allowed to approve payments on this job yet, and only the job's owner wallet can allow it. Connect the owner's wallet for the first approval.",
          );
        }
        setStep("register");
        const hash = await writeContract(wagmiConfig, {
          address: config.vault,
          abi: jobVaultAbi,
          functionName: "setApprover",
          args: [vaultJobId, account, true],
        });
        const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
        if (receipt.status !== "success") throw new Error("The transaction failed on Arc");
      }

      setStep("sign");
      const signature = await signTypedData({ ...typed, account });
      const message = typed.message as { deadline: bigint; policyVersion: bigint };
      await api(`/approvals/${pending.authorizationId}`, {
        body: {
          verdict: "APPROVE",
          approverAddress: account,
          signature,
          deadline: Number(message.deadline),
          policyVersion: Number(message.policyVersion),
        },
      });
    },
    onSettled: () => {
      setStep(null);
      return queryClient.invalidateQueries();
    },
  });
  return { ...mutation, step };
}

export function useReject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pending: PendingApproval) =>
      api(`/approvals/${pending.authorizationId}`, { body: { verdict: "REJECT" } }),
    onSettled: () => queryClient.invalidateQueries(),
  });
}
