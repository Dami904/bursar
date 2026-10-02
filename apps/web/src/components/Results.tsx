import { useState } from "react";
import type { Run } from "../lib/api.js";
import { time } from "../lib/format.js";

const OUTCOME: Record<string, string> = {
  completed: "Done",
  step_limit: "Stopped at its step limit",
  time_limit: "Stopped at its time limit",
  refused: "Stopped by a refusal",
  revoked: "Stopped: its key was revoked",
  error: "Didn't finish",
};

/**
 * What Bursar's AI operator delivered: the answer to the brief, run by run. The newest is open.
 * Answers are model-written (from paid seller content), so they're plain text, never markup.
 */
export function Results({ runs }: { runs: Run[] }) {
  const [open, setOpen] = useState<string | null>(runs[0]?.id ?? null);
  if (runs.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 text-xs text-muted">Results</h2>
      {runs.map((run) => {
        const isOpen = open === run.id;
        return (
          <div key={run.id} className="border-t border-line py-3">
            <button
              className="flex w-full items-baseline justify-between gap-3 text-left text-sm"
              onClick={() => setOpen(isOpen ? null : run.id)}
              aria-expanded={isOpen}
            >
              <span className="min-w-0 truncate">{run.brief}</span>
              <span className="shrink-0 text-xs text-muted">
                {OUTCOME[run.outcome] ?? run.outcome} · {time(run.at)}
              </span>
            </button>
            {isOpen && (
              <div className="mt-3 space-y-2">
                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                  {run.summary ?? "No answer was written for this run."}
                </p>
                <p className="text-xs text-muted">
                  {run.steps} steps · AI cost ${run.aiCost} · {run.model}
                </p>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
