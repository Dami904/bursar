import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { Markdown } from "../components/Markdown.js";
import { OUTCOME } from "../components/Results.js";
import { ErrorLine, Loading } from "../components/ui.js";
import { api, type Decision, type Run } from "../lib/api.js";
import { money, time } from "../lib/format.js";
import { DecisionRow } from "./Job.js";
import { SiteHeader } from "./landing/Landing.js";

interface RunResult {
  job: { id: string; title: string };
  run: Run;
  /** What the run bought to produce the answer, newest first. */
  purchases: Decision[];
  /** USDC paid for this result (settled purchases). */
  paid: string;
}

/**
 * What an agent delivered, on its own page: the brief, the answer, and what it paid for to get
 * there, each purchase linking to its evidence. The same page serves the owner and the public demo.
 */
export function ResultPage({ demo = false }: { demo?: boolean }) {
  const { id = "", runId = "" } = useParams();
  const q = useQuery({
    queryKey: ["result", demo, id, runId],
    queryFn: () => api<RunResult>(demo ? `/demo/runs/${runId}` : `/jobs/${id}/runs/${runId}`),
  });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorLine error={q.error} />;
  const { job, run, purchases, paid } = q.data;

  return (
    <main className="mx-auto max-w-2xl">
      <Link to={demo ? "/demo" : `/app/jobs/${job.id}`} className="text-sm text-muted">
        ← {job.title}
      </Link>
      <p className="mt-6 text-xs uppercase tracking-wide text-muted">Result</p>
      <h1 className="mt-1 text-xl font-medium">{run.brief}</h1>
      <p className="mt-1 text-xs text-muted">
        {OUTCOME[run.outcome] ?? run.outcome} · {time(run.at)} · paid {money(paid)} USDC
      </p>

      <article className="mt-6 rounded-xl border border-line p-5">
        {run.summary ? (
          <Markdown text={run.summary} />
        ) : (
          <p className="text-sm text-muted">No answer was written for this run.</p>
        )}
      </article>

      <section className="mt-8">
        <h2 className="mb-2 text-xs text-muted">
          What it paid for ({purchases.length} {purchases.length === 1 ? "decision" : "decisions"})
        </h2>
        {purchases.length === 0 && (
          <p className="border-t border-line py-4 text-sm text-muted">
            Nothing: it answered without buying anything.
          </p>
        )}
        {purchases.map((d) => (
          <DecisionRow
            key={d.id}
            d={d}
            evidenceBase={demo ? "/demo/decisions" : "/app/decisions"}
          />
        ))}
      </section>

      <p className="mt-6 text-xs text-muted">
        {run.steps} steps · AI cost ${run.aiCost} · {run.model}. Each purchase links to its
        evidence: the rules checked, the payment on Arc and the audit trail.
      </p>
    </main>
  );
}

/** The public demo's result page, with the site header. */
export function DemoResult() {
  return (
    <div className="min-h-dvh bg-bg">
      <SiteHeader />
      <div className="px-5 pb-24 pt-8">
        <ResultPage demo />
      </div>
    </div>
  );
}
