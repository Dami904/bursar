import { formatUsdc } from "@bursar/money";
import { jobVaultAbi } from "@bursar/payments/chain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import type { Hex } from "viem";
import { useConnection, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { api, type Job } from "../lib/api.js";
import { config } from "../lib/config.js";
import { money } from "../lib/format.js";
import { wagmiConfig } from "../lib/wagmi.js";
import { Button, Card, ErrorLine, TxLink } from "./ui.js";

type Action = "pause" | "unpause" | "closeJob";

/** Reads the job as the vault sees it, and sends the owner's wallet transactions. */
function useVaultJob(job: Job) {
  const vaultJobId = job.onChain.vaultJobId as Hex | null;
  const onChain = useReadContract({
    address: config.vault,
    abi: jobVaultAbi,
    functionName: "getJob",
    args: [vaultJobId ?? "0x"],
    query: { enabled: vaultJobId !== null },
  });
  const connection = useConnection();
  const { mutateAsync: switchChain } = useSwitchChain();
  const { mutateAsync: write } = useWriteContract();
  const queryClient = useQueryClient();

  const send = async (action: Action) => {
    if (vaultJobId === null) throw new Error("The job isn't in the vault yet");
    if (connection.chainId !== config.chain.id) await switchChain({ chainId: config.chain.id });
    const hash = await write({
      address: config.vault,
      abi: jobVaultAbi,
      functionName: action,
      args: [vaultJobId],
    });
    const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
    if (receipt.status !== "success") throw new Error("The transaction failed on Arc");
    await onChain.refetch();
    // Closing changes everything the page shows (spent, left, status): refresh it now, not later.
    void queryClient.invalidateQueries();
    // The indexer picks the change up within seconds; refresh once it has.
    setTimeout(() => void queryClient.invalidateQueries(), 3000);
  };
  // JobVault's Status enum: 1 active, 2 paused, 3 closed.
  const status = onChain.data?.status;
  return {
    send,
    paused: status === 2,
    closed: status === 3,
    returned: onChain.data === undefined ? null : onChain.data.withdrawn,
  };
}

/**
 * The job's controls: pause (an emergency stop, nothing leaves the vault), resume, and close,
 * which returns every unspent USDC to the owner's wallet in the same transaction.
 */
export function JobMenu({ job }: { job: Job }) {
  const vault = useVaultJob(job);
  const [open, setOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const act = useMutation({ mutationFn: vault.send, onSuccess: () => setOpen(false) });
  const inFlight = Number(job.reserved) + Number(job.pendingApproval) + Number(job.unresolved) > 0;

  if (vault.closed) return null;
  return (
    <div className="relative">
      <button
        className="rounded-full p-1.5 text-muted hover:bg-surface hover:text-ink"
        aria-label="Job actions"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setConfirmClose(false);
        }}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <Card className="absolute right-0 z-10 mt-1 w-64 space-y-2 p-3 text-sm">
          {vault.paused ? (
            <Button
              className="w-full"
              disabled={act.isPending}
              onClick={() => act.mutate("unpause")}
            >
              Resume job
            </Button>
          ) : (
            <Button className="w-full" disabled={act.isPending} onClick={() => act.mutate("pause")}>
              Pause job
            </Button>
          )}
          <Button
            className={`w-full ${confirmClose ? "border-blocked text-blocked" : ""}`}
            disabled={act.isPending || inFlight}
            onClick={() => (confirmClose ? act.mutate("closeJob") : setConfirmClose(true))}
          >
            {confirmClose ? `Close and return ${money(job.remaining)} USDC` : "Close job"}
          </Button>
          <p className="text-xs text-muted">
            {inFlight
              ? "Close once nothing is held, waiting or stuck."
              : "Closing returns every unspent USDC to your wallet. It can't be undone."}
          </p>
          {act.isPending && <p className="text-xs text-muted">Confirm in your wallet…</p>}
          <ErrorLine error={act.error} />
        </Card>
      )}
    </div>
  );
}

/** Shown on a frozen, paused or closed job, with what the owner can do about it. */
export function JobStatusCard({ job }: { job: Job }) {
  const vault = useVaultJob(job);
  const queryClient = useQueryClient();
  const unfreeze = useMutation({
    mutationFn: async () => {
      await api(`/jobs/${job.id}/unfreeze`, { body: {} });
      if (vault.paused) await vault.send("unpause");
      void queryClient.invalidateQueries();
    },
  });

  if (vault.closed) {
    return (
      <Card className="mb-6 text-sm">
        <p className="font-medium">Closed</p>
        <p className="mt-1 text-muted">
          {vault.returned !== null && vault.returned > 0n
            ? `${money(formatUsdc(vault.returned))} USDC went back to your wallet.`
            : "Nothing was left to return."}
        </p>
        {job.closeTx != null && (
          <p className="mt-2 flex items-center gap-2 text-xs text-muted">
            The closing transaction <TxLink hash={job.closeTx} />
          </p>
        )}
      </Card>
    );
  }
  if (job.frozenReason !== null) {
    return (
      <Card className="mb-6 border-blocked text-sm">
        <p className="font-medium text-blocked">Frozen</p>
        <p className="mt-1 text-muted">{job.frozenReason}</p>
        <p className="mt-2 text-xs text-muted">
          Nothing can be paid until you've checked this and unfrozen the job.
        </p>
        <Button className="mt-3" disabled={unfreeze.isPending} onClick={() => unfreeze.mutate()}>
          {unfreeze.isPending ? "Confirm in your wallet…" : "I've checked it, unfreeze"}
        </Button>
        <ErrorLine error={unfreeze.error} />
      </Card>
    );
  }
  if (vault.paused) {
    return (
      <Card className="mb-6 border-needs text-sm">
        <p className="font-medium">Paused</p>
        <p className="mt-1 text-muted">Nothing leaves the vault until you resume it.</p>
      </Card>
    );
  }
  return null;
}
