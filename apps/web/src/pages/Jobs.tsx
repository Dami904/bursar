import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Link } from "react-router";
import { BudgetBar, Button, Card, ErrorLine, Loading } from "../components/ui.js";
import { api, type Job } from "../lib/api.js";
import { money } from "../lib/format.js";

export function Jobs() {
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: () => api<{ jobs: Job[] }>("/jobs") });

  return (
    <main>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-medium">Jobs</h1>
        <Link to="/app/jobs/new">
          <Button primary>
            <Plus size={16} /> New job
          </Button>
        </Link>
      </div>
      {jobs.isPending && <Loading />}
      <ErrorLine error={jobs.error} />
      {jobs.data?.jobs.length === 0 && (
        <Card className="py-12 text-center">
          <p className="font-medium">Create your first job</p>
          <p className="mt-1 text-sm text-muted">Give your agents a budget they can't overspend.</p>
        </Card>
      )}
      {jobs.data && jobs.data.jobs.length > 0 && <Totals jobs={jobs.data.jobs} />}
      <div className="grid gap-3 sm:grid-cols-2">
        {jobs.data?.jobs.map((job) => (
          <Link key={job.id} to={`/app/jobs/${job.id}`}>
            <Card className="transition hover:border-muted">
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium">{job.title}</p>
                {(job.needsYou ?? 0) > 0 ? (
                  <span className="rounded-full bg-needs px-2 text-xs font-medium text-on-accent">
                    {job.needsYou} needs you
                  </span>
                ) : (
                  <span className="text-xs text-muted">{statusWord(job)}</span>
                )}
              </div>
              <p className="mt-3 text-2xl font-medium tracking-tight">
                {money(job.remaining)}{" "}
                <span className="text-sm font-normal text-muted">of {money(job.budget)} left</span>
              </p>
              <div className="mt-3">
                <BudgetBar job={job} legend={false} />
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </main>
  );
}

function statusWord(job: Job) {
  if (job.frozenReason !== null) return "Frozen";
  return {
    DRAFT: "Draft",
    PENDING_CHAIN: "Setting up",
    ACTIVE: "Live",
    PAUSED: "Paused",
    CLOSED: "Closed",
  }[job.status];
}

const units = (value: string) => Math.round(Number(value) * 1_000_000);
const usdc = (n: number) => money((n / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""));

/** The whole fleet at a glance: what's funded, paid and held across every job, and what waits on you. */
function Totals({ jobs }: { jobs: Job[] }) {
  const sum = (pick: (j: Job) => string) => jobs.reduce((n, j) => n + units(pick(j)), 0);
  const waiting = jobs.reduce((n, j) => n + (j.needsYou ?? 0), 0);
  const tiles: { label: string; value: string; unit?: string; tone?: string }[] = [
    { label: "Funded", value: usdc(sum((j) => j.budget)), unit: "USDC" },
    { label: "Paid", value: usdc(sum((j) => j.settled)), unit: "USDC", tone: "text-paid" },
    {
      label: "Held or stuck",
      value: usdc(sum((j) => j.reserved) + sum((j) => j.unresolved)),
      unit: "USDC",
      tone: "text-held",
    },
    {
      label: "Waiting for you",
      value: String(waiting),
      tone: waiting > 0 ? "text-needs" : "text-muted",
    },
  ];
  return (
    <dl className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-2xl border border-line bg-surface px-4 py-3">
          <dt className="text-xs text-muted">{t.label}</dt>
          <dd className={`mt-1 text-2xl font-medium tracking-tight tabular-nums ${t.tone ?? ""}`}>
            {t.value} {t.unit && <span className="text-xs font-normal text-muted">{t.unit}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
