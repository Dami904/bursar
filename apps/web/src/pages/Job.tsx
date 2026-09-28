import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { AgentsSection, BriefSection, displayName, PayeesSection } from "../components/JobSetup.js";
import { BudgetBar, Button, Card, ErrorLine, Initial, Loading, Status } from "../components/ui.js";
import {
  api,
  type Agent,
  type Decision,
  type Job as JobT,
  type PendingApproval,
} from "../lib/api.js";
import { useApprove } from "../lib/approve.js";
import { txUrl } from "../lib/config.js";
import { blockedBecause, money, statusOf, time, whatFor } from "../lib/format.js";

export function Job() {
  const { id = "" } = useParams();
  const job = useQuery({ queryKey: ["job", id], queryFn: () => api<JobT>(`/jobs/${id}`) });
  const decisions = useQuery({
    queryKey: ["decisions", id],
    queryFn: () => api<{ decisions: Decision[] }>(`/jobs/${id}/decisions`),
  });
  const agents = useQuery({
    queryKey: ["agents", id],
    queryFn: () => api<{ agents: Agent[] }>(`/jobs/${id}/agents`),
  });
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api<{ pending: PendingApproval[] }>("/approvals"),
  });
  const anchor = useQuery({
    queryKey: ["audit-status"],
    queryFn: () =>
      api<{ ok: boolean; latestAnchor: { anchorSeq: number; txHash: string | null } | null }>(
        "/audit/status",
      ),
  });

  if (job.isPending) return <Loading />;
  if (job.error) return <ErrorLine error={job.error} />;
  const j = job.data;
  const waiting = approvals.data?.pending.filter((p) => p.jobId === id) ?? [];
  const profit = Number(j.profit);

  return (
    <main>
      <div className="mb-8 flex items-center justify-between gap-3">
        <h1 className="text-xl font-medium">{j.title}</h1>
        {anchor.data?.latestAnchor && anchor.data.ok && (
          <a
            href={
              anchor.data.latestAnchor.txHash ? txUrl(anchor.data.latestAnchor.txHash) : undefined
            }
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-full border border-seal bg-seal-bg px-2.5 py-0.5 text-xs font-medium text-seal-text"
          >
            <span className="size-1.5 rounded-full bg-seal" /> Anchored #
            {anchor.data.latestAnchor.anchorSeq}
          </a>
        )}
      </div>

      {j.frozenReason !== null && (
        <Card className="mb-6 border-blocked text-sm">
          <p className="font-medium text-blocked">Frozen</p>
          <p className="mt-1 text-muted">{j.frozenReason}</p>
        </Card>
      )}

      <p className="text-xs text-muted">Left</p>
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="text-4xl font-medium tracking-tight">{money(j.remaining)}</span>
        <span className="text-muted">of {money(j.budget)} USDC</span>
        {Number(j.revenueReceived) > 0 && (
          <span className={`ml-auto text-sm ${profit >= 0 ? "text-paid" : "text-blocked"}`}>
            {profit >= 0 ? "+" : ""}
            {j.profit} profit
          </span>
        )}
      </div>
      <div className="mt-4">
        <BudgetBar job={j} />
      </div>

      {waiting.map((p) => (
        <ApprovalCard key={p.authorizationId} pending={p} />
      ))}

      <div className="mt-8 grid gap-8 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section>
          <h2 className="mb-2 text-xs text-muted">Decisions</h2>
          {decisions.isPending && <Loading />}
          {decisions.data?.decisions.length === 0 && (
            <p className="border-t border-line py-6 text-sm text-muted">
              Nothing yet. Decisions show up here as agents spend.
            </p>
          )}
          {decisions.data?.decisions.map((d) => (
            <DecisionRow key={d.id} d={d} />
          ))}
        </section>
        <div className="space-y-8">
          <section>
            <h2 className="mb-2 text-xs text-muted">Agents</h2>
            <AgentsSection jobId={j.id} agents={agents.data?.agents ?? []} />
          </section>
          <section>
            <h2 className="mb-2 text-xs text-muted">Operator brief</h2>
            <BriefSection job={j} />
          </section>
          <section>
            <h2 className="mb-2 text-xs text-muted">Who can be paid</h2>
            <PayeesSection job={j} />
          </section>
        </div>
      </div>
    </main>
  );
}

export function ApprovalCard({ pending }: { pending: PendingApproval }) {
  const approve = useApprove();
  return (
    <Card className="mt-6 border-needs">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">
            {money(pending.amount)} →{" "}
            {pending.payee.length > 30
              ? `${pending.payee.slice(0, 6)}…${pending.payee.slice(-4)}`
              : pending.payee}
          </p>
          <p className="truncate font-voice italic text-muted">"{pending.reasoning}"</p>
        </div>
        <Button primary disabled={approve.isPending} onClick={() => approve.mutate(pending)}>
          {approve.isPending ? "Sign in wallet…" : "Approve"}
        </Button>
      </div>
      <div className="mt-2">
        <ErrorLine error={approve.error} />
      </div>
    </Card>
  );
}

function DecisionRow({ d }: { d: Decision }) {
  const [open, setOpen] = useState(false);
  const status = statusOf(d);
  return (
    <div className="border-t border-line">
      <button className="w-full py-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <div className="flex items-center gap-3">
          <Initial name={displayName(d.agent.name)} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{whatFor(d)}</p>
            <p className="truncate text-xs text-muted">
              {displayName(d.agent.name)} · {time(d.at)} ·{" "}
              {d.result === "DENIED" && d.reason !== null ? (
                (blockedBecause[d.reason] ?? d.reason)
              ) : (
                <span className="font-voice italic">{d.reasoning}</span>
              )}
            </p>
          </div>
          <span
            className={`text-sm tabular-nums ${d.result === "DENIED" ? "text-muted line-through" : ""}`}
          >
            {money(d.amount)}
          </span>
          <span className="w-16 text-right">
            <Status {...status} />
          </span>
        </div>
      </button>
      {open && (
        <div className="mb-3 ml-9 space-y-2">
          <p className="font-voice italic">"{d.reasoning}"</p>
          <div className="flex gap-4 text-xs text-muted">
            <Link to={`/app/decisions/${d.id}`} className="underline">
              Evidence
            </Link>
            {d.paymentTx !== null && (
              <a
                href={txUrl(d.paymentTx)}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 underline"
              >
                Payment <ExternalLink size={11} />
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
