import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { Link } from "react-router";
import { AgentsSection, PayeesSection, type Payee } from "../components/JobSetup.js";
import { Results } from "../components/Results.js";
import { BudgetBar, Button, ErrorLine, Loading } from "../components/ui.js";
import { api, ApiError, type Agent, type Decision, type Job, type Run } from "../lib/api.js";
import { addressUrl, config, txUrl } from "../lib/config.js";
import { money } from "../lib/format.js";
import { DecisionRow } from "./Job.js";
import { EvidencePage } from "./Evidence.js";
import { Footer } from "./landing/Sections.js";
import { SiteHeader } from "./landing/Landing.js";

interface DemoData {
  job: Job;
  /** Answers from Bursar's AI operator; absent on an API older than this page. */
  runs?: Run[];
  decisions: Decision[];
  agents: Agent[];
  payees: Payee[];
  anchor: { anchorSeq: number; txHash: string | null } | null;
}

/**
 * A real job on Arc (testnet or mainnet, per build), run by Bursar's own AI operator, open to anyone. Read-only: the same
 * job page owners see, without any buttons. It refreshes itself as the operator works.
 */
export function Demo() {
  const q = useQuery({
    queryKey: ["demo"],
    queryFn: () => api<DemoData>("/demo"),
    refetchInterval: 10_000,
  });
  return (
    <div className="min-h-dvh bg-bg">
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-5 pb-24 pt-8">
        {q.data && (
          <div className="mb-8 rounded-2xl border border-seal bg-seal-bg px-4 py-3 text-sm text-seal-text">
            A real job on Arc {config.mainnet ? "mainnet, spending real USDC" : "testnet"}, worked
            by Bursar's own AI operator. Every transaction opens on the chain. Payments above 0.10
            USDC are approved by a demo approver after a minute.
          </div>
        )}
        {q.data && <RunPanel />}
        {q.isPending && <Loading />}
        {q.error && <DemoUnavailable error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && <DemoJob data={q.data} />}
      </main>
      <Footer />
    </div>
  );
}

export interface RunStatus {
  enabled: boolean;
  canRun?: boolean;
  message?: string | null;
  retryAfterSeconds?: number | null;
  next?: { number: number; of: number; title: string; maxCost: string };
  runsToday?: number;
  maxPerDay?: number;
}

/**
 * The demo doesn't run on its own: a visitor starts the next scene here, and Bursar's AI operator
 * works it live. The server paces it (a few minutes apart, a few a day, and the budget is spread
 * to last), and says why when it says not now.
 */
export function RunPanel() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["demo-run"],
    queryFn: () => api<RunStatus>("/demo/run"),
    refetchInterval: 15_000,
  });
  const run = useMutation({
    mutationFn: () => api<RunStatus>("/demo/run", { body: {} }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["demo-run"] });
      void queryClient.invalidateQueries({ queryKey: ["demo"] });
    },
  });
  const s = status.data;
  if (s === undefined || !s.enabled || s.next === undefined) return null;
  const started = run.isSuccess;
  return (
    <section className="mb-8 rounded-2xl border border-line bg-surface p-5">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-seal">Run it yourself</p>
      <h2 className="mt-1 text-lg font-medium">
        Scene {s.next.number} of {s.next.of}: {s.next.title}
      </h2>
      <p className="mt-1 text-sm text-muted">
        Starts Bursar's AI operator on this job, live. It spends up to {s.next.maxCost} testnet
        USDC, and every payment opens on Arc.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          primary
          disabled={s.canRun !== true || run.isPending || started}
          onClick={() => run.mutate()}
        >
          {run.isPending ? "Starting…" : started ? "Scene started" : "Run this scene"}
        </Button>
        {started ? (
          <span className="text-sm text-muted">
            The operator begins within half a minute. Scenes with an approval take about two
            minutes. This page updates as it works.
          </span>
        ) : s.canRun !== true && s.message ? (
          <span className="text-sm text-muted">{s.message}</span>
        ) : null}
      </div>
      {s.runsToday !== undefined && s.maxPerDay !== undefined && (
        <p className="mt-3 text-xs text-muted">
          Scenes run in the last 24 hours: {s.runsToday} of {s.maxPerDay}
        </p>
      )}
      <ErrorLine error={run.error} />
    </section>
  );
}

/**
 * What a visitor sees when there's no demo to show: no demo job is set up on this network yet, or
 * the server can't be reached. Said plainly, with somewhere to go, instead of an error code.
 */
export function DemoUnavailable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const missing = error instanceof ApiError && error.status === 404;
  return (
    <div className="mx-auto max-w-xl rounded-2xl border border-line bg-surface p-8 text-center">
      <h1 className="text-xl font-medium">
        {missing ? "The live demo is being set up" : "The demo isn't answering right now"}
      </h1>
      <p className="mt-3 text-muted">
        {missing
          ? "A fresh demo job is being funded on Arc. You'll be able to run a scene here once it's live."
          : "The server may be waking up. Give it a moment and try again."}
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        {!missing && (
          <Button primary onClick={onRetry}>
            Try again
          </Button>
        )}
        {config.mainnet && config.otherNetworkUrl !== undefined && (
          <a
            href={`${config.otherNetworkUrl}/demo`}
            className="inline-flex items-center rounded-full bg-accent px-4 py-2 text-sm font-medium text-on-accent"
          >
            Open the testnet demo
          </a>
        )}
        <Link
          to="/docs/introduction"
          className="inline-flex items-center rounded-full border border-line px-4 py-2 text-sm font-medium hover:bg-bg"
        >
          How it works
        </Link>
        <Link
          to="/"
          className="inline-flex items-center rounded-full border border-line px-4 py-2 text-sm font-medium hover:bg-bg"
        >
          Back to the start
        </Link>
      </div>
    </div>
  );
}

function DemoJob({ data }: { data: DemoData }) {
  const { job: j, decisions, agents, payees, anchor } = data;
  const profit = Number(j.profit);
  return (
    <>
      <div className="mb-8 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-medium">{j.title}</h1>
        {anchor && (
          <a
            href={anchor.txHash ? txUrl(anchor.txHash) : undefined}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-full border border-seal bg-seal-bg px-2.5 py-0.5 text-xs font-medium text-seal-text"
          >
            <span className="size-1.5 rounded-full bg-seal" /> Anchored #{anchor.anchorSeq}
          </a>
        )}
        {j.onChain.agentWallet && (
          <a
            href={addressUrl(j.onChain.agentWallet)}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-xs text-muted underline"
          >
            Job wallet <ExternalLink size={11} />
          </a>
        )}
      </div>

      <p className="text-xs text-muted">Left</p>
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="text-4xl font-medium tracking-tight">{money(j.remaining)}</span>
        <span className="text-muted">of {money(j.budget)} USDC</span>
        {Number(j.revenueReceived) > 0 && (
          <span className={`ml-auto text-sm ${profit >= 0 ? "text-paid" : "text-blocked"}`}>
            {money(j.revenueReceived)} in from the customer · {profit >= 0 ? "+" : ""}
            {profit.toFixed(2)} profit
          </span>
        )}
      </div>
      <div className="mt-4">
        <BudgetBar job={j} />
      </div>

      <div className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-8 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-8">
          <Results runs={data.runs ?? []} resultBase="/demo/results" />
          <section>
            <h2 className="mb-2 text-xs text-muted">Decisions</h2>
            {decisions.length === 0 && (
              <p className="border-t border-line py-6 text-sm text-muted">
                No scene has run yet. Use the button above to start one.
              </p>
            )}
            {decisions.map((d) => (
              <DecisionRow key={d.id} d={d} evidenceBase="/demo/decisions" />
            ))}
          </section>
        </div>
        <div className="space-y-8">
          <section>
            <h2 className="mb-2 text-xs text-muted">Agents</h2>
            <AgentsSection jobId={j.id} agents={agents} readOnly />
          </section>
          {j.brief && (
            <section>
              <h2 className="mb-2 text-xs text-muted">Current brief</h2>
              <p className="border-t border-line pt-3 font-voice text-sm italic">"{j.brief}"</p>
            </section>
          )}
          <section>
            <h2 className="mb-2 text-xs text-muted">Who can be paid</h2>
            <PayeesSection job={j} given={payees} readOnly />
          </section>
        </div>
      </div>
    </>
  );
}

/** One demo decision's evidence, public. */
export function DemoEvidence() {
  return (
    <div className="min-h-dvh bg-bg">
      <SiteHeader />
      <div className="px-5 pb-24 pt-8">
        <EvidencePage demo />
      </div>
    </div>
  );
}
