import { jobVaultAbi, usdcAbi } from "@bursar/payments/chain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { parseUnits, type Hex } from "viem";
import { useConnection, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { readContract, waitForTransactionReceipt } from "wagmi/actions";
import { api, type Agent, type Job } from "../lib/api.js";
import { config } from "../lib/config.js";
import { money, shortAddress } from "../lib/format.js";
import { wagmiConfig } from "../lib/wagmi.js";
import { ConnectTabs } from "./Connect.js";
import { Button, Card, Dot, ErrorLine, AgentMark } from "./ui.js";

const field =
  "min-w-0 flex-1 rounded-xl border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-muted";

/** Sub-agents are marked with ↳, so a "helper:" prefix in the name only repeats that. */
export function displayName(name: string) {
  return name.replace(/^helper:\s*/i, "");
}

/** A new agent key, shown once with a copy button. */
export function KeyReveal({ agentKey, onDone }: { agentKey: string; onDone?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Card className="my-3">
      <p className="text-sm">New agent key</p>
      <p className="mt-1 text-xs text-muted">
        Shown once. Give it to the agent, not to a chat: anyone with it can spend within this job's
        rules.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-track px-2 py-1.5 font-mono text-xs">
          {agentKey}
        </code>
        <Button
          aria-label="Copy key"
          onClick={() => void navigator.clipboard.writeText(agentKey).then(() => setCopied(true))}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </Button>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-muted hover:text-ink">
          Connect your agent
        </summary>
        <div className="mt-3">
          <ConnectTabs agentKey={agentKey} />
        </div>
      </details>
      {onDone && (
        <button className="mt-3 text-xs text-muted underline" onClick={onDone}>
          Done, hide it
        </button>
      )}
    </Card>
  );
}

/**
 * The agent tree, in one straight column. Sub-agents (spawned by the agent above them) are marked
 * with ↳. Each live agent can be replaced (fresh key, same place, only what was left) or revoked.
 */
export function AgentsSection({
  jobId,
  agents,
  readOnly = false,
}: {
  jobId: string;
  agents: Agent[];
  /** Closed jobs: show the tree, offer no actions. */
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  const add = useMutation({
    mutationFn: () =>
      api<{ key: string }>(`/jobs/${jobId}/agents`, {
        body: { name: name.trim(), role: "agent" },
      }),
    onSuccess: ({ key }) => {
      setNewKey(key);
      setAdding(false);
      setName("");
      void queryClient.invalidateQueries();
    },
  });

  const past = agents.filter((a) => a.status === "REVOKED");
  const visible = showPast ? agents : agents.filter((a) => a.status === "ACTIVE");
  const children = (parentId: string | null) =>
    visible.filter(
      (a) =>
        a.parentAgentId === parentId ||
        // A live sub-agent whose parent is hidden still shows, at the top.
        (parentId === null &&
          a.parentAgentId !== null &&
          !visible.some((v) => v.id === a.parentAgentId)),
    );
  const render = (agent: Agent, depth: number): React.ReactNode => (
    <div key={agent.id}>
      <AgentRow agent={agent} depth={depth} onKey={setNewKey} readOnly={readOnly} />
      {visible.filter((c) => c.parentAgentId === agent.id).map((c) => render(c, depth + 1))}
    </div>
  );

  return (
    <div>
      {newKey && <KeyReveal agentKey={newKey} onDone={() => setNewKey(null)} />}
      {visible.length === 0 && (
        <p className="border-t border-line py-4 text-sm text-muted">No agents yet.</p>
      )}
      {children(null).map((a) => render(a, 0))}
      {!readOnly && (
        <div className="flex items-center justify-between border-t border-line pt-2 text-xs text-muted">
          {adding ? (
            <form
              className="flex w-full gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim() !== "") add.mutate();
              }}
            >
              <input
                className={field}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Agent name"
                autoFocus
              />
              <Button primary disabled={add.isPending || name.trim() === ""}>
                Add
              </Button>
            </form>
          ) : (
            <>
              <button
                className="flex items-center gap-1 hover:text-ink"
                onClick={() => setAdding(true)}
              >
                <Plus size={12} /> Add agent
              </button>
              {past.length > 0 && (
                <button
                  className="flex items-center gap-1.5 hover:text-ink"
                  onClick={() => setShowPast(!showPast)}
                >
                  <Dot tone="muted" /> {showPast ? "Hide" : "Show"} {past.length} past
                </button>
              )}
            </>
          )}
        </div>
      )}
      <ErrorLine error={add.error} />
    </div>
  );
}

function AgentRow({
  agent,
  depth,
  onKey,
  readOnly,
}: {
  agent: Agent;
  depth: number;
  onKey: (key: string) => void;
  readOnly: boolean;
}) {
  const queryClient = useQueryClient();
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const limit = agent.spendLimit === null ? null : Number(agent.spendLimit);
  const used = Number(agent.committed);
  const gone = agent.status === "REVOKED";

  const replace = useMutation({
    mutationFn: () =>
      api<{ key: string }>(`/agents/${agent.id}/replace`, { body: { name: agent.name } }),
    onSuccess: ({ key }) => {
      onKey(key);
      setMenu(false);
      void queryClient.invalidateQueries();
    },
  });
  const revoke = useMutation({
    mutationFn: () => api(`/agents/${agent.id}/revoke`, { body: {} }),
    onSuccess: () => {
      setMenu(false);
      void queryClient.invalidateQueries();
    },
  });

  return (
    <div className={`border-t border-line py-2.5 ${gone ? "opacity-50" : ""}`}>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="flex min-w-0 items-center gap-2">
          <AgentMark id={agent.id} name={displayName(agent.name)} />
          {depth > 0 && (
            <span className="text-muted" aria-label="sub-agent of the agent above">
              ↳
            </span>
          )}
          <span className={`truncate ${gone ? "line-through" : ""}`}>
            {displayName(agent.name)}
          </span>
        </span>
        <span className="flex items-center gap-1">
          <span className="whitespace-nowrap text-xs text-muted tabular-nums">
            {money(agent.committed)}
            {limit !== null && ` / ${money(agent.spendLimit ?? "0")}`}
          </span>
          {!gone && !readOnly && (
            <button
              className="rounded-full p-1 text-muted hover:bg-surface hover:text-ink"
              aria-label={`Actions for ${displayName(agent.name)}`}
              aria-expanded={menu}
              onClick={() => {
                setMenu(!menu);
                setConfirm(false);
              }}
            >
              <MoreHorizontal size={14} />
            </button>
          )}
        </span>
      </div>
      {limit !== null && limit > 0 && (
        <div className="ml-8 mt-1.5 h-0.5 rounded-full bg-track">
          <div
            className="h-0.5 rounded-full bg-ink"
            style={{ width: `${Math.min(100, (used / limit) * 100)}%` }}
          />
        </div>
      )}
      {menu && (
        <div className="ml-8 mt-2 flex flex-wrap gap-2">
          <Button disabled={replace.isPending} onClick={() => replace.mutate()}>
            {replace.isPending ? "Replacing…" : "Replace"}
          </Button>
          <Button
            className={confirm ? "border-blocked text-blocked" : ""}
            disabled={revoke.isPending}
            onClick={() => (confirm ? revoke.mutate() : setConfirm(true))}
          >
            {confirm ? "Revoke, and its sub-agents" : "Revoke"}
          </Button>
          <ErrorLine error={replace.error ?? revoke.error} />
        </div>
      )}
    </div>
  );
}

/**
 * A job that's open in the vault but not funded yet: the setup stopped part way (a closed tab, a
 * wallet that never answered). Finishes it from here. Each step is skipped when Arc already shows
 * it done, so running it twice never deposits twice.
 */
export function FinishSetup({ job }: { job: Job }) {
  const queryClient = useQueryClient();
  const connection = useConnection();
  const { mutateAsync: switchChain } = useSwitchChain();
  const { mutateAsync: write } = useWriteContract();
  const [step, setStep] = useState<string | null>(null);
  const vaultJobId = job.onChain.vaultJobId as Hex | null;
  const missing = parseUnits(job.budget, 6) - parseUnits(job.deposited, 6);
  const finish = useMutation({
    mutationFn: async () => {
      const owner = connection.address;
      if (owner === undefined) throw new Error("Connect your wallet first");
      if (vaultJobId === null) throw new Error("The job isn't in the vault yet");
      if (connection.chainId !== config.chain.id) await switchChain({ chainId: config.chain.id });
      const send = async (label: string, tx: () => Promise<Hex>) => {
        setStep(label);
        const receipt = await waitForTransactionReceipt(wagmiConfig, { hash: await tx() });
        if (receipt.status !== "success")
          throw new Error(`${label}: the transaction failed on Arc`);
      };
      if (missing > 0n) {
        const allowed = await readContract(wagmiConfig, {
          address: config.usdc,
          abi: usdcAbi,
          functionName: "allowance",
          args: [owner, config.vault],
        });
        if (allowed < missing) {
          await send("Allow the deposit", () =>
            write({
              address: config.usdc,
              abi: usdcAbi,
              functionName: "approve",
              args: [config.vault, missing],
            }),
          );
        }
        await send(`Deposit ${job.budget} USDC`, () =>
          write({
            address: config.vault,
            abi: jobVaultAbi,
            functionName: "fund",
            args: [vaultJobId, missing],
          }),
        );
      }
      const approver = await readContract(wagmiConfig, {
        address: config.vault,
        abi: jobVaultAbi,
        functionName: "isApprover",
        args: [vaultJobId, owner],
      });
      if (!approver) {
        await send("Let your wallet approve payments", () =>
          write({
            address: config.vault,
            abi: jobVaultAbi,
            functionName: "setApprover",
            args: [vaultJobId, owner, true],
          }),
        );
      }
      setStep("Waiting for Arc");
    },
    onSettled: () => {
      setStep(null);
      void queryClient.invalidateQueries({ queryKey: ["job", job.id] });
    },
  });

  // Never offer a deposit into a frozen job: it may be a vault job someone else controls.
  if (
    vaultJobId === null ||
    job.status === "CLOSED" ||
    job.frozenReason !== null ||
    missing <= 0n
  ) {
    return null;
  }
  return (
    <Card>
      <p className="font-medium">Finish setting up this job</p>
      <p className="mt-1 text-sm text-muted">
        It&apos;s open in the vault but holds {job.deposited} of its {job.budget} USDC. Your wallet
        will ask you to allow and make the deposit, then to approve payments, skipping anything
        already done.
      </p>
      <Button primary className="mt-3" disabled={finish.isPending} onClick={() => finish.mutate()}>
        {finish.isPending ? `${step ?? "Working"}…` : "Finish setup"}
      </Button>
      <ErrorLine error={finish.error} />
    </Card>
  );
}

export interface Payee {
  id: string;
  kind: "X402_ORIGIN" | "ADDRESS" | "MARKETPLACE";
  value: string;
  label: string | null;
  /** MARKETPLACE only: the owner's limits on what it allows. */
  filters?: { categories: string[]; maxPrice: string | null } | null;
}

/**
 * Who the job may pay. Sellers (websites) only need to be listed here; vendors (wallets) are
 * paid straight from the vault, so the vault must allow them too, from the owner's wallet.
 */
export function PayeesSection({
  job,
  readOnly = false,
  given,
}: {
  job: Job;
  readOnly?: boolean;
  /** Payees already loaded (the public demo); otherwise they're fetched for the owner. */
  given?: Payee[];
}) {
  const queryClient = useQueryClient();
  const fetched = useQuery({
    queryKey: ["payees", job.id],
    queryFn: () => api<{ payees: Payee[] }>(`/jobs/${job.id}/payees`),
    enabled: given === undefined,
  });
  const payees = given === undefined ? fetched : { data: { payees: given } };
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const kind = /^0x[0-9a-fA-F]{40}$/.test(value.trim()) ? "ADDRESS" : "X402_ORIGIN";
  const ok = kind === "ADDRESS" || /^https?:\/\/\S+$/.test(value.trim());

  const add = useMutation({
    mutationFn: () =>
      api(`/jobs/${job.id}/payees`, {
        body: { kind, value: value.trim(), ...(label.trim() ? { label: label.trim() } : {}) },
      }),
    onSuccess: () => {
      setValue("");
      setLabel("");
      void queryClient.invalidateQueries();
    },
  });

  return (
    <div>
      {payees.data?.payees.length === 0 && (
        <p className="border-t border-line py-4 text-sm text-muted">
          Nobody yet. Agents can only pay who's listed here.
        </p>
      )}
      {payees.data?.payees.map((p) => (
        <PayeeRow key={p.id} payee={p} job={job} readOnly={readOnly} />
      ))}
      {!readOnly && (
        <form
          className="flex gap-2 border-t border-line pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) add.mutate();
          }}
        >
          <input
            className={field}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="URL or 0x…"
          />
          <input
            className={`${field} max-w-24`}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Name"
          />
          <Button aria-label="Add payee" disabled={!ok || add.isPending}>
            <Plus size={14} />
          </Button>
        </form>
      )}
      <ErrorLine error={add.error} />
    </div>
  );
}

function PayeeRow({ payee, job, readOnly }: { payee: Payee; job: Job; readOnly: boolean }) {
  const vendor = payee.kind === "ADDRESS";
  const vaultJobId = job.onChain.vaultJobId as Hex | null;
  const allowed = useReadContract({
    address: config.vault,
    abi: jobVaultAbi,
    functionName: "isPayee",
    args: [vaultJobId ?? "0x", payee.value as Hex],
    query: { enabled: vendor && vaultJobId !== null },
  });
  const connection = useConnection();
  const { mutateAsync: switchChain } = useSwitchChain();
  const { mutateAsync: write } = useWriteContract();
  const allow = useMutation({
    mutationFn: async () => {
      if (vaultJobId === null) throw new Error("The job isn't in the vault yet");
      if (connection.chainId !== config.chain.id) await switchChain({ chainId: config.chain.id });
      const hash = await write({
        address: config.vault,
        abi: jobVaultAbi,
        functionName: "setPayee",
        args: [vaultJobId, payee.value as Hex, true],
      });
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash });
      if (receipt.status !== "success") throw new Error("The transaction failed on Arc");
    },
    onSuccess: () => void allowed.refetch(),
  });

  return (
    <div className="border-t border-line py-2.5">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="min-w-0">
          <span className="block truncate">
            {payee.label ??
              (vendor ? shortAddress(payee.value) : payee.value.replace(/^https?:\/\//, ""))}
          </span>
          <span className="text-xs text-muted">
            {vendor
              ? "Vendor"
              : payee.kind === "MARKETPLACE"
                ? `Marketplace: any listed service${payee.filters?.maxPrice ? `, up to ${payee.filters.maxPrice} USDC a call` : ""}`
                : "Seller"}
          </span>
        </span>
        {vendor &&
          (allowed.data === true ? (
            <span className="text-xs text-paid">Allowed</span>
          ) : allowed.data === false && !readOnly ? (
            <Button disabled={allow.isPending} onClick={() => allow.mutate()}>
              {allow.isPending ? "Confirm in wallet…" : "Allow in vault"}
            </Button>
          ) : null)}
      </div>
      <ErrorLine error={allow.error} />
    </div>
  );
}

/**
 * The operator's brief. With one, Bursar starts the AI operator when the job goes live and again
 * when a customer pays in. "Run now" asks for another run.
 */
export function BriefSection({ job }: { job: Job }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(job.brief ?? "");
  const save = useMutation({
    mutationFn: (brief: string | null) => api<Job>(`/jobs/${job.id}/brief`, { body: { brief } }),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries();
    },
  });

  if (editing || job.brief === null) {
    return (
      <form
        className="space-y-2 border-t border-line pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(text.trim() || null);
        }}
      >
        <textarea
          className={`${field} min-h-20 w-full`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What should the agent do? It starts on its own once this is set."
        />
        <div className="flex gap-2">
          <Button primary disabled={save.isPending || text.trim() === ""}>
            Save
          </Button>
          {job.brief !== null && (
            <Button type="button" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          )}
        </div>
        <ErrorLine error={save.error} />
      </form>
    );
  }
  return (
    <div className="border-t border-line pt-3 text-sm">
      <p className="font-voice italic">"{job.brief}"</p>
      <div className="mt-2 flex items-center justify-between text-xs text-muted">
        <span>
          {job.operatorRunAt
            ? `Last run ${new Date(job.operatorRunAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`
            : "Starts when the job is live"}
        </span>
        <span className="flex gap-3">
          <button className="underline hover:text-ink" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            className="underline hover:text-ink"
            disabled={save.isPending}
            onClick={() => save.mutate(job.brief)}
          >
            Run now
          </button>
        </span>
      </div>
    </div>
  );
}
