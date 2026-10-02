import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { AgentsSection, PayeesSection, type Payee } from "../components/JobSetup.js";
import { Results } from "../components/Results.js";
import { BudgetBar, ErrorLine, Loading } from "../components/ui.js";
import { api, type Agent, type Decision, type Job, type Run } from "../lib/api.js";
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
        <div className="mb-8 rounded-2xl border border-seal bg-seal-bg px-4 py-3 text-sm text-seal-text">
          A real job on Arc {config.mainnet ? "mainnet, spending real USDC" : "testnet"}, run by
          Bursar's own AI operator. Every transaction opens on the chain. Payments above 0.10 USDC
          are approved by a demo approver after a minute.
        </div>
        {q.isPending && <Loading />}
        <ErrorLine error={q.error} />
        {q.data && <DemoJob data={q.data} />}
      </main>
      <Footer />
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
          <Results runs={data.runs ?? []} />
          <section>
            <h2 className="mb-2 text-xs text-muted">Decisions</h2>
            {decisions.length === 0 && (
              <p className="border-t border-line py-6 text-sm text-muted">
                The operator's first run is on its way.
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
