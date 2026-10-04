import { useQuery } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { MediaGallery } from "../components/Media.js";
import {
  AgentMark,
  Button,
  Card,
  CopyButton,
  ErrorLine,
  Skeleton,
  TxLink,
} from "../components/ui.js";
import { api, type Decision, type PendingApproval } from "../lib/api.js";
import { useApprove, useReject } from "../lib/approve.js";
import { config } from "../lib/config.js";
import {
  blockedBecause,
  money,
  ruleLines,
  shortPayee,
  statusOf,
  toneBg,
  toneText,
  verdictOf,
  whatFor,
  type Tone,
} from "../lib/format.js";
import type { Evidence } from "./Evidence.js";

type Filter = "all" | Tone;

/** The filters, in the order they read: what's happening to money, from good news to bad. */
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "needs", label: "Needs you" },
  { id: "held", label: "Held" },
  { id: "paid", label: "Paid" },
  { id: "stuck", label: "Stuck" },
  { id: "blocked", label: "Blocked" },
  { id: "muted", label: "Returned" },
];

function dayOf(iso: string) {
  const d = new Date(iso);
  const days = Math.round(
    (new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** True on a screen wide enough to show the list and a detail pane side by side. */
const wide = () => window.matchMedia("(min-width: 1024px)").matches;

/**
 * The daybook: every request across the owner's jobs, newest first, grouped by day like a ledger.
 * Filter by what happened to the money. On a wide screen a line opens beside the list, with
 * Approve and Reject right there when it needs you (J and K move between lines); on a phone it
 * opens the full evidence page.
 */
export function Activity() {
  const q = useQuery({
    queryKey: ["activity"],
    queryFn: () => api<{ decisions: Decision[] }>("/decisions?limit=200"),
  });
  const [filter, setFilter] = useState<Filter>("all");
  const [params, setParams] = useSearchParams();
  const all = q.data?.decisions ?? [];
  const counts = new Map<Filter, number>([["all", all.length]]);
  for (const d of all) {
    const tone = statusOf(d).tone;
    counts.set(tone, (counts.get(tone) ?? 0) + 1);
  }
  const shown = filter === "all" ? all : all.filter((d) => statusOf(d).tone === filter);
  const selected = shown.find((d) => d.id === params.get("d")) ?? shown[0];

  function select(id: string) {
    setParams({ d: id }, { replace: true });
  }

  // J and K step through the lines, like an inbox.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target !== null && /^(input|textarea|select)$/i.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || !wide()) return;
      const step = event.key === "j" ? 1 : event.key === "k" ? -1 : 0;
      if (step === 0 || shown.length === 0) return;
      const at = selected === undefined ? -1 : shown.findIndex((d) => d.id === selected.id);
      const next = shown[Math.min(Math.max(at + step, 0), shown.length - 1)];
      if (next !== undefined) {
        event.preventDefault();
        select(next.id);
        document.getElementById(`line-${next.id}`)?.scrollIntoView({ block: "nearest" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Group by day, keeping newest first.
  const days: { day: string; rows: Decision[] }[] = [];
  for (const d of shown) {
    const day = dayOf(d.at);
    const last = days.at(-1);
    if (last?.day === day) last.rows.push(d);
    else days.push({ day, rows: [d] });
  }

  return (
    <main>
      <p className="text-xs font-medium uppercase tracking-[0.2em] text-seal">Daybook</p>
      <h1 className="mt-1 text-2xl font-medium tracking-tight">Every request, every job</h1>
      <p className="mt-1 text-sm text-muted">
        Newest first. <span className="hidden lg:inline">J and K move between lines.</span>
      </p>

      <div className="mt-5 flex flex-wrap gap-2" role="tablist" aria-label="Filter by outcome">
        {FILTERS.filter((f) => f.id === "all" || (counts.get(f.id) ?? 0) > 0).map((f) => (
          <button
            key={f.id}
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition ${
              filter === f.id
                ? "border-ink bg-ink text-bg"
                : "border-line text-muted hover:text-ink"
            }`}
          >
            {f.id !== "all" && (
              <span
                className={`size-1.5 rounded-full ${toneBg[f.id as Tone]}`}
                aria-hidden="true"
              />
            )}
            {f.label}
            <span className="tabular-nums opacity-70">{counts.get(f.id) ?? 0}</span>
          </button>
        ))}
      </div>

      <ErrorLine error={q.error} />
      {q.isPending && (
        <div className="mt-8 space-y-4" role="status" aria-label="Loading">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}
      {q.data && all.length === 0 && (
        <Card className="mt-8 py-12 text-center">
          <p className="font-medium">Nothing in the daybook yet</p>
          <p className="mt-1 text-sm text-muted">
            When an agent spends or is stopped, the line shows up here.
          </p>
        </Card>
      )}
      {q.data && all.length > 0 && shown.length === 0 && (
        <p className="mt-8 text-sm text-muted">Nothing with that outcome.</p>
      )}

      {shown.length > 0 && (
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-8">
          <div>
            {days.map(({ day, rows }) => {
              const paid = rows
                .filter((d) => statusOf(d).tone === "paid")
                .reduce((sum, d) => sum + Math.round(Number(d.amount) * 1_000_000), 0);
              return (
                <section key={day} className="mt-8">
                  <div className="flex items-baseline justify-between border-b border-line pb-2">
                    <h2 className="text-xs font-medium uppercase tracking-[0.18em] text-muted">
                      {day}
                    </h2>
                    <span className="font-mono text-xs text-muted">
                      {rows.length} {rows.length === 1 ? "request" : "requests"}
                      {paid > 0 &&
                        ` · paid ${money((paid / 1_000_000).toFixed(6).replace(/0+$/, ""))}`}
                    </span>
                  </div>
                  <ul>
                    {rows.map((d) => (
                      <DaybookLine
                        key={d.id}
                        d={d}
                        active={selected?.id === d.id}
                        onSelect={() => select(d.id)}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
          <aside className="mt-8 hidden lg:block">
            <div className="sticky top-6">
              {selected && <DetailPane key={selected.id} d={selected} />}
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}

function DaybookLine({
  d,
  active,
  onSelect,
}: {
  d: Decision;
  active: boolean;
  onSelect: () => void;
}) {
  const status = statusOf(d);
  const picture = d.media?.find((m) => m.kind === "image");
  return (
    <li
      id={`line-${d.id}`}
      className={`border-b border-dotted border-line ${active ? "lg:bg-surface" : ""}`}
    >
      <Link
        to={`/app/decisions/${d.id}`}
        aria-current={active ? "true" : undefined}
        onClick={(event) => {
          // Beside the list on a wide screen; the full page on a phone.
          if (wide()) {
            event.preventDefault();
            onSelect();
          }
        }}
        className={`flex items-center gap-3 border-l-2 px-2 py-3 hover:bg-surface ${
          active ? "lg:border-ink" : "border-transparent"
        }`}
      >
        <span className="w-11 shrink-0 font-mono text-xs text-muted">{clock(d.at)}</span>
        {picture ? (
          <img
            src={picture.url}
            alt=""
            loading="lazy"
            className="size-6 shrink-0 rounded-md object-cover"
          />
        ) : (
          <AgentMark id={d.agent.id} name={d.agent.name} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{whatFor(d)}</span>
          <span className="block truncate text-xs text-muted">
            {d.job?.title ?? "Job"} · {d.agent.name}
            {d.result === "DENIED" && d.reason !== null && (
              <span className="text-blocked"> · {blockedBecause[d.reason] ?? d.reason}</span>
            )}
          </span>
        </span>
        <span className="text-right">
          <span
            className={`block font-mono text-sm tabular-nums ${d.result === "DENIED" ? "text-muted line-through" : ""}`}
          >
            {money(d.amount)}
          </span>
          <span className={`block text-xs font-medium ${toneText[status.tone]}`}>
            {status.word}
          </span>
        </span>
      </Link>
    </li>
  );
}

/**
 * One decision beside the list: the verdict and why, the rules, how it was paid and what came
 * back. A payment waiting for the owner gets Approve and Reject here.
 */
function DetailPane({ d }: { d: Decision }) {
  const evidence = useQuery({
    queryKey: ["evidence", false, d.id],
    queryFn: () => api<Evidence>(`/decisions/${d.id}`),
  });
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api<{ pending: PendingApproval[] }>("/approvals"),
    enabled: d.state === "PENDING_APPROVAL",
  });
  const verdict = verdictOf({ result: d.result, state: d.state });
  const pending = approvals.data?.pending.find((p) => p.authorizationId === d.authorizationId);

  return (
    <Card className="p-5">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted">
        {verdict.headline}
      </p>
      <div className="mt-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-3xl font-medium tracking-tight">{money(d.amount)}</p>
          <p className="truncate text-sm text-muted">to {shortPayee(d.payee)}</p>
        </div>
        <span className={`text-sm font-medium ${toneText[verdict.tone]}`}>{statusOf(d).word}</span>
      </div>
      <p className="mt-1 text-xs text-muted">
        {d.job?.title} · {d.agent.name} ·{" "}
        {config.mainnet ? "Arc mainnet, real USDC" : "Arc testnet, test USDC"}
      </p>
      <p className="mt-4 font-voice italic">"{d.reasoning}"</p>

      {pending !== undefined && <ApproveBar pending={pending} />}
      {d.state === "PENDING_APPROVAL" && pending === undefined && !approvals.isPending && (
        <p className="mt-4 rounded-xl border border-needs p-3 text-sm text-needs">
          This is waiting for an approver.{" "}
          <Link to="/app/approvals" className="underline">
            Open approvals
          </Link>
        </p>
      )}

      {evidence.isPending && <Skeleton className="mt-5 h-24 w-full" />}
      {evidence.data && <PaneEvidence e={evidence.data} />}
      <Link to={`/app/decisions/${d.id}`} className="mt-5 inline-block text-sm underline">
        Open the full evidence
      </Link>
    </Card>
  );
}

function PaneEvidence({ e }: { e: Evidence }) {
  const failed = e.decision.checks.find((c) => !c.passed);
  const passed = e.decision.checks.filter((c) => c.passed).length;
  const pay = e.payment;
  return (
    <div className="mt-5 space-y-4 border-t border-line pt-4 text-sm">
      <div>
        <p className="flex items-center gap-1.5">
          {failed ? (
            <X size={13} className="text-blocked" />
          ) : (
            <Check size={13} className="text-paid" />
          )}
          <span className={failed ? "font-medium text-blocked" : ""}>
            {failed
              ? (ruleLines[failed.check]?.fail ?? failed.check)
              : `All ${passed} rules passed`}
          </span>
        </p>
        {failed && (
          <p className="mt-1 text-xs text-muted">
            {passed} of {e.decision.checks.length} rules passed before it stopped.
          </p>
        )}
      </div>
      {pay && e.decision.result !== "DENIED" && (
        <div className="space-y-1.5">
          <p className="text-muted">
            {pay.rail === "GATEWAY" ? "Paid through Circle Gateway" : "Paid from the job's vault"}
          </p>
          {(pay.paymentTx ?? pay.vaultTx) && (
            <p className="flex items-center justify-between gap-3">
              <span className="text-muted">Payment</span>
              <TxLink hash={(pay.paymentTx ?? pay.vaultTx) as string} />
            </p>
          )}
          {pay.gatewayTransferId && (
            <p className="flex items-center justify-between gap-3">
              <span className="text-muted">Gateway transfer</span>
              <span className="flex items-center gap-1.5 font-mono text-xs text-muted">
                {pay.gatewayTransferId.slice(0, 8)}…
                <CopyButton text={pay.gatewayTransferId} label="Copy the transfer id" />
              </span>
            </p>
          )}
          {e.anchor && (
            <p className="flex items-center justify-between gap-3">
              <span className="text-muted">Sealed on Arc #{e.anchor.anchorSeq}</span>
              {e.anchor.txHash && <TxLink hash={e.anchor.txHash} />}
            </p>
          )}
        </div>
      )}
      {pay?.media && pay.media.length > 0 && <MediaGallery items={pay.media} />}
    </div>
  );
}

function ApproveBar({ pending }: { pending: PendingApproval }) {
  const approve = useApprove();
  const reject = useReject();
  const busy = approve.isPending || reject.isPending;
  return (
    <div className="mt-4 rounded-xl border border-needs p-3">
      <p className="text-sm text-needs">This is waiting for you.</p>
      <div className="mt-3 flex gap-2">
        <Button primary className="flex-1" disabled={busy} onClick={() => approve.mutate(pending)}>
          {approve.isPending ? "Sign in your wallet…" : "Approve"}
        </Button>
        <Button disabled={busy} onClick={() => reject.mutate(pending)}>
          Reject
        </Button>
      </div>
      <div className="mt-2">
        <ErrorLine error={approve.error ?? reject.error} />
      </div>
    </div>
  );
}
