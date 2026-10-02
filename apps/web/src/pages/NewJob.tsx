import { jobVaultAbi, usdcAbi } from "@bursar/payments/chain";
import { parseUsdc } from "@bursar/money";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Plus, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { Hex } from "viem";
import { useConnection, useSwitchChain, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { KeyReveal } from "../components/JobSetup.js";
import { Button, Card, ErrorLine } from "../components/ui.js";
import { api, type Job } from "../lib/api.js";
import { config } from "../lib/config.js";
import { wagmiConfig } from "../lib/wagmi.js";

interface Payee {
  kind: "X402_ORIGIN" | "ADDRESS" | "MARKETPLACE";
  value: string;
  label: string;
  /** MARKETPLACE only: the most per call, in USDC. */
  maxPrice?: string;
}

/** The marketplace an owner can allow in one click (the API knows it as "circle-agents"). */
const CIRCLE_MARKETPLACE = { id: "circle-agents", name: "Circle Agent Marketplace" };

type StepState = "todo" | "doing" | "done" | "failed";

const field =
  "w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-muted";

/**
 * Create a job in three short steps. The last one runs the on-chain part from the owner's wallet:
 * create the job in the vault, fund it, let the owner's wallet approve payments, and allow any
 * vendors. Each step can be retried if the wallet is closed or a transaction fails.
 */
export function NewJob() {
  const [step, setStep] = useState(1);
  const [title, setTitle] = useState("");
  const [customer, setCustomer] = useState("");
  const [budget, setBudget] = useState("1.00");
  const [threshold, setThreshold] = useState("0.10");
  const [days, setDays] = useState("7");
  const [brief, setBrief] = useState("");
  const [payees, setPayees] = useState<Payee[]>([]);
  const [error, setError] = useState<unknown>(null);

  const detailsOk = title.trim() !== "" && valid(budget) && valid(threshold) && Number(days) >= 1;

  return (
    <main className="mx-auto max-w-md">
      <h1 className="text-xl font-medium">New job</h1>
      <div className="mb-8 mt-3 flex gap-1.5">
        {[1, 2, 3].map((n) => (
          <span
            key={n}
            className={`h-1 flex-1 rounded-full ${n <= step ? "bg-ink" : "bg-track"}`}
          />
        ))}
      </div>

      {step === 1 && (
        <div className="space-y-4">
          <Label text="Name">
            <input
              className={field}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Explainer film"
              autoFocus
            />
          </Label>
          <Label text="Customer" hint="Optional">
            <input
              className={field}
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              placeholder="Acme"
            />
          </Label>
          <div className="grid grid-cols-2 gap-3">
            <Label text="Budget" hint="USDC">
              <input
                className={field}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                inputMode="decimal"
              />
            </Label>
            <Label text="Ask me above" hint="USDC">
              <input
                className={field}
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                inputMode="decimal"
              />
            </Label>
          </div>
          <Label text="Ends in" hint="days">
            <input
              className={field}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              inputMode="numeric"
            />
          </Label>
          <Label text="What should the agent do?" hint="Optional">
            <textarea
              className={`${field} min-h-20`}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="Buy one insight line a day for the newsletter."
            />
          </Label>
          <Button primary className="w-full" disabled={!detailsOk} onClick={() => setStep(2)}>
            Next
          </Button>
        </div>
      )}

      {step === 2 && (
        <PayeesStep
          payees={payees}
          setPayees={setPayees}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}

      {step === 3 && (
        <FundStep
          draft={{
            brief: brief.trim(),
            title: title.trim(),
            customer: customer.trim() || "Internal",
            budget,
            threshold,
            days: Number(days),
            payees,
          }}
          onBack={() => setStep(2)}
          onError={setError}
        />
      )}
      <div className="mt-3">
        <ErrorLine error={error} />
      </div>
    </main>
  );
}

function PayeesStep({
  payees,
  setPayees,
  onBack,
  onNext,
}: {
  payees: Payee[];
  setPayees: (p: Payee[]) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [maxPrice, setMaxPrice] = useState("0.05");
  const kind = /^0x[0-9a-fA-F]{40}$/.test(value.trim()) ? "ADDRESS" : "X402_ORIGIN";
  const market = payees.find((p) => p.kind === "MARKETPLACE");
  const others = payees.filter((p) => p.kind !== "MARKETPLACE");
  const ok = kind === "ADDRESS" || /^https?:\/\/\S+$/.test(value.trim());
  return (
    <div className="space-y-4">
      <div>
        <p className="font-medium">Who can be paid</p>
        <p className="text-sm text-muted">
          Sellers (a website) and vendors (a wallet). Nobody else.
        </p>
      </div>
      <label className="flex gap-3 rounded-xl border border-line p-3 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={market !== undefined}
          onChange={(e) =>
            setPayees(
              e.target.checked
                ? [
                    ...others,
                    {
                      kind: "MARKETPLACE",
                      value: CIRCLE_MARKETPLACE.id,
                      label: CIRCLE_MARKETPLACE.name,
                      maxPrice,
                    },
                  ]
                : others,
            )
          }
        />
        <span className="min-w-0 flex-1">
          <span className="block font-medium">Any service in {CIRCLE_MARKETPLACE.name}</span>
          <span className="block text-muted">
            The agent can search it and buy what it lists on this network, never above the listed
            price. Your budget, caps and approvals still apply.
          </span>
          {market !== undefined && (
            <span className="mt-2 flex items-center gap-2">
              <span className="text-muted">At most</span>
              <input
                className={`${field} max-w-24`}
                inputMode="decimal"
                value={maxPrice}
                onChange={(e) => {
                  setMaxPrice(e.target.value);
                  setPayees([...others, { ...market, maxPrice: e.target.value.trim() }]);
                }}
                aria-label="Most per call, USDC"
              />
              <span className="text-muted">USDC per call</span>
            </span>
          )}
        </span>
      </label>
      {others.map((p, i) => (
        <div
          key={p.value}
          className="flex items-center justify-between gap-2 border-t border-line pt-3 text-sm"
        >
          <span className="min-w-0">
            <span className="block truncate">{p.label || p.value}</span>
            <span className="text-xs text-muted">{p.kind === "ADDRESS" ? "Vendor" : "Seller"}</span>
          </span>
          <button
            aria-label="Remove"
            className="rounded-full p-1.5 hover:bg-surface"
            onClick={() => setPayees(payees.filter((q) => q !== others[i]))}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <input
          className={field}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https://api.seller.com or 0x…"
        />
        <input
          className={`${field} max-w-28`}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Name"
        />
        <Button
          aria-label="Add"
          disabled={!ok}
          onClick={() => {
            setPayees([...payees, { kind, value: value.trim(), label: label.trim() }]);
            setValue("");
            setLabel("");
          }}
        >
          <Plus size={16} />
        </Button>
      </div>
      <div className="flex gap-2">
        <Button onClick={onBack}>Back</Button>
        <Button primary className="flex-1" onClick={onNext}>
          {payees.length === 0 ? "Skip for now" : "Next"}
        </Button>
      </div>
    </div>
  );
}

interface Draft {
  brief: string;
  title: string;
  customer: string;
  budget: string;
  threshold: string;
  days: number;
  payees: Payee[];
}

function FundStep({
  draft,
  onBack,
  onError,
}: {
  draft: Draft;
  onBack: () => void;
  onError: (e: unknown) => void;
}) {
  const connection = useConnection();
  const { mutateAsync: switchChain } = useSwitchChain();
  const { mutateAsync: write } = useWriteContract();
  const queryClient = useQueryClient();
  const [job, setJob] = useState<Job | null>(null);
  const [states, setStates] = useState<Record<string, StepState>>({});
  const [running, setRunning] = useState(false);
  const [agentKey, setAgentKey] = useState<string | null>(null);

  const vendors = draft.payees.filter((p) => p.kind === "ADDRESS");
  const steps = [
    { id: "create", label: "Create the job" },
    { id: "vault", label: "Open it in the vault" },
    { id: "approve", label: "Allow the deposit" },
    { id: "fund", label: `Deposit ${draft.budget} USDC` },
    { id: "approver", label: "Let your wallet approve payments" },
    ...vendors.map((v) => ({
      id: `vendor:${v.value}`,
      label: `Allow ${v.label || v.value.slice(0, 8)}`,
    })),
    { id: "live", label: "Waiting for Arc" },
  ];

  async function run() {
    setRunning(true);
    onError(null);
    const mark = (id: string, s: StepState) => setStates((prev) => ({ ...prev, [id]: s }));
    const once = async (id: string, fn: () => Promise<void>) => {
      if (states[id] === "done") return;
      mark(id, "doing");
      try {
        await fn();
        mark(id, "done");
      } catch (e) {
        mark(id, "failed");
        throw e;
      }
    };
    const send = async (tx: Promise<Hex>) => {
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash: await tx });
      if (receipt.status !== "success") throw new Error("The transaction failed on Arc");
    };
    try {
      const owner = connection.address;
      if (owner === undefined) throw new Error("Connect your wallet first");
      if (connection.chainId !== config.chain.id) await switchChain({ chainId: config.chain.id });

      let current = job;
      await once("create", async () => {
        const expiresAt = new Date(Date.now() + draft.days * 86_400_000);
        current = await api<Job>("/jobs", {
          body: {
            title: draft.title,
            customer: draft.customer,
            budget: draft.budget,
            perTxCap: draft.budget,
            approvalThreshold: draft.threshold,
            windowCap: draft.budget,
            expiresAt: expiresAt.toISOString(),
            ...(draft.brief ? { brief: draft.brief } : {}),
          },
        });
        for (const p of draft.payees) {
          await api(`/jobs/${current.id}/payees`, {
            body: {
              kind: p.kind,
              value: p.value,
              ...(p.label ? { label: p.label } : {}),
              ...(p.kind === "MARKETPLACE" && p.maxPrice
                ? { filters: { maxPrice: p.maxPrice } }
                : {}),
            },
          });
        }
        setJob(current);
      });
      if (current === null) throw new Error("The job wasn't created");
      const j: Job = current;
      const vaultJobId = j.onChain.vaultJobId as Hex;
      const amount = parseUsdc(draft.budget);

      await once("vault", () =>
        send(
          write({
            address: config.vault,
            abi: jobVaultAbi,
            functionName: "createJob",
            args: [
              vaultJobId,
              {
                agentWallet: j.onChain.agentWallet as Hex,
                budget: amount,
                perTxCap: parseUsdc(j.perTxCap),
                approvalThreshold: parseUsdc(j.approvalThreshold),
                windowCap: parseUsdc(j.windowCap),
                window: BigInt(j.windowSeconds),
                expiry: BigInt(Math.floor(new Date(j.expiresAt).getTime() / 1000)),
              },
            ],
          }),
        ),
      );
      await once("approve", () =>
        send(
          write({
            address: config.usdc,
            abi: usdcAbi,
            functionName: "approve",
            args: [config.vault, amount],
          }),
        ),
      );
      await once("fund", () =>
        send(
          write({
            address: config.vault,
            abi: jobVaultAbi,
            functionName: "fund",
            args: [vaultJobId, amount],
          }),
        ),
      );
      await once("approver", () =>
        send(
          write({
            address: config.vault,
            abi: jobVaultAbi,
            functionName: "setApprover",
            args: [vaultJobId, owner, true],
          }),
        ),
      );
      for (const v of vendors) {
        await once(`vendor:${v.value}`, () =>
          send(
            write({
              address: config.vault,
              abi: jobVaultAbi,
              functionName: "setPayee",
              args: [vaultJobId, v.value as Hex, true],
            }),
          ),
        );
      }
      await once("live", async () => {
        for (let i = 0; i < 60; i += 1) {
          const fresh = await api<Job>(`/jobs/${j.id}`);
          if (fresh.status === "ACTIVE") return;
          await new Promise((r) => setTimeout(r, 2000));
        }
        throw new Error("Arc is slow to confirm; the job will go live on its own shortly");
      });
      const { key } = await api<{ key: string }>(`/jobs/${j.id}/agents`, {
        body: { name: "Operator", role: "operator" },
      });
      setAgentKey(key);
      void queryClient.invalidateQueries();
    } catch (e) {
      onError(e);
    } finally {
      setRunning(false);
    }
  }

  if (agentKey !== null && job !== null) return <Done job={job} agentKey={agentKey} />;

  return (
    <div className="space-y-4">
      <Card>
        <p className="font-medium">{draft.title}</p>
        <p className="mt-1 text-sm text-muted">
          {draft.budget} USDC · ask above {draft.threshold} · {draft.days} days ·{" "}
          {draft.payees.length} {draft.payees.length === 1 ? "payee" : "payees"}
        </p>
      </Card>
      <ol className="space-y-2">
        {steps.map((s) => {
          const st = states[s.id] ?? "todo";
          return (
            <li key={s.id} className="flex items-center gap-3 text-sm">
              <span
                className={`flex size-5 items-center justify-center rounded-full border ${
                  st === "done"
                    ? "border-paid bg-paid text-on-accent"
                    : st === "failed"
                      ? "border-blocked"
                      : "border-line"
                } ${st === "doing" ? "animate-pulse border-ink" : ""}`}
              >
                {st === "done" && <Check size={12} />}
              </span>
              <span className={st === "todo" ? "text-muted" : ""}>{s.label}</span>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted">
        Your wallet will ask you to confirm each step. Arc gas is paid in USDC.
      </p>
      <div className="flex gap-2">
        <Button onClick={onBack} disabled={running || job !== null}>
          Back
        </Button>
        <Button primary className="flex-1" disabled={running} onClick={() => void run()}>
          {running
            ? "Working…"
            : Object.values(states).includes("failed")
              ? "Try again"
              : "Create and fund"}
        </Button>
      </div>
    </div>
  );
}

function Done({ job, agentKey }: { job: Job; agentKey: string }) {
  return (
    <div className="space-y-4">
      <p className="font-medium">{job.title} is live</p>
      <KeyReveal agentKey={agentKey} />
      <Link to={`/app/jobs/${job.id}`}>
        <Button primary className="w-full">
          Open job
        </Button>
      </Link>
    </div>
  );
}

function Label({
  text,
  hint,
  children,
}: {
  text: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm">
        {text} {hint && <span className="text-muted">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function valid(amount: string) {
  try {
    return parseUsdc(amount.trim()) > 0n;
  } catch {
    return false;
  }
}
