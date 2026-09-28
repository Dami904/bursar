import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TypedDataDefinition } from "viem";
import { useConnect, useConnection, useConnectors, useSignTypedData } from "wagmi";
import { api, type PendingApproval } from "./api.js";

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

/**
 * Approve: the wallet signs the exact message JobVault checks (it names the amount and who gets
 * paid), then the API records it and the worker releases the money.
 */
export function useApprove() {
  const connection = useConnection();
  const connectors = useConnectors();
  const { mutateAsync: connect } = useConnect();
  const { mutateAsync: signTypedData } = useSignTypedData();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (pending: PendingApproval) => {
      if (pending.typedData === null) throw new Error("This job isn't live on-chain yet");
      let account = connection.address;
      if (account === undefined) {
        const connector = connectors[0];
        if (connector === undefined) throw new Error("Connect a wallet first");
        account = (await connect({ connector })).accounts[0];
      }
      if (account === undefined) throw new Error("Connect a wallet first");
      const typed = revive(pending.typedData as WireTypedData);
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
    onSettled: () => queryClient.invalidateQueries(),
  });
}

export function useReject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pending: PendingApproval) =>
      api(`/approvals/${pending.authorizationId}`, { body: { verdict: "REJECT" } }),
    onSettled: () => queryClient.invalidateQueries(),
  });
}
