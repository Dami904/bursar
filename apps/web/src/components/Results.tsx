import { Link } from "react-router";
import type { Run } from "../lib/api.js";
import { time } from "../lib/format.js";
import { Markdown } from "./Markdown.js";

export const OUTCOME: Record<string, string> = {
  completed: "Done",
  step_limit: "Stopped at its step limit",
  time_limit: "Stopped at its time limit",
  refused: "Stopped by a refusal",
  revoked: "Stopped: its key was revoked",
  error: "Didn't finish",
};

/** The first few lines of an answer, cut at a line break near the limit. */
function preview(text: string, limit = 420): { text: string; more: boolean } {
  if (text.length <= limit) return { text, more: false };
  const cut = text.lastIndexOf("\n", limit);
  return { text: text.slice(0, cut > limit / 2 ? cut : limit).trimEnd(), more: true };
}

/**
 * What Bursar's AI operator delivered, on the job page: the newest answer as a preview with a link
 * to its full result page, then earlier runs. `resultBase` is the console's or the public demo's.
 */
export function Results({ runs, resultBase }: { runs: Run[]; resultBase: string }) {
  if (runs.length === 0) return null;
  const [latest, ...earlier] = runs as [Run, ...Run[]];
  const shown = preview(latest.summary ?? "No answer was written for this run.");
  return (
    <section>
      <h2 className="mb-2 text-xs text-muted">Results</h2>
      <div className="rounded-xl border border-line p-4">
        <div className="flex items-baseline justify-between gap-3 text-xs text-muted">
          <span className="min-w-0 truncate">{latest.brief}</span>
          <span className="shrink-0">
            {OUTCOME[latest.outcome] ?? latest.outcome} · {time(latest.at)}
          </span>
        </div>
        <div className="relative mt-2">
          <Markdown text={shown.text} />
          {shown.more && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-bg" />
          )}
        </div>
        <Link
          to={`${resultBase}/${latest.id}`}
          className="mt-3 inline-block rounded-full bg-ink px-3 py-1.5 text-xs text-bg"
        >
          Open result
        </Link>
      </div>
      {earlier.map((run) => (
        <Link
          key={run.id}
          to={`${resultBase}/${run.id}`}
          className="flex items-baseline justify-between gap-3 border-b border-line py-2.5 text-sm hover:text-ink"
        >
          <span className="min-w-0 truncate">{run.brief}</span>
          <span className="shrink-0 text-xs text-muted">
            {OUTCOME[run.outcome] ?? run.outcome} · {time(run.at)}
          </span>
        </Link>
      ))}
    </section>
  );
}
