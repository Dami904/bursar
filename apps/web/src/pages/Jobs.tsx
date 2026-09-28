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
