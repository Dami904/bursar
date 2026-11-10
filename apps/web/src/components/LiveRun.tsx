import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type LiveEvent, type LiveRun as LiveRunT } from "../lib/api.js";
import { toneBg, toneText, type Tone } from "../lib/format.js";

const TONE: Record<LiveEvent["kind"], Tone> = {
  started: "held",
  step: "muted",
  found: "held",
  paid: "paid",
  blocked: "blocked",
  waiting: "needs",
  helper: "held",
  retry: "stuck",
  error: "blocked",
  finished: "paid",
};

/** How long after the run started, e.g. "+12s" or "+1m 05s". */
export function sinceStart(startMs: number, atMs: number): string {
  const s = Math.max(0, Math.round((atMs - startMs) / 1000));
  if (s < 60) return `+${s}s`;
  return `+${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const QUIET = 6;

/**
 * What the operator is doing, line by line, as it happens. Every line is plain text: the model's
 * words can echo what a seller sent, so nothing here is rendered as markup.
 */
export function LiveRunView({ live }: { live: LiveRunT }) {
  const [all, setAll] = useState(false);
  const first = live.events[0];
  if (first === undefined) return null;
  const start = new Date(first.at).getTime();
  const shown = live.active || all ? live.events : live.events.slice(-QUIET);
  const hidden = live.events.length - shown.length;
  return (
    <section aria-label="Live run" aria-live={live.active ? "polite" : "off"}>
      <h2 className="mb-2 flex items-center gap-2 text-xs text-muted">
        {live.active ? (
          <>
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-paid opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-paid" />
            </span>
            Working now
          </>
        ) : (
          "Last run"
        )}
      </h2>
      <ol className="space-y-1 border-t border-line pt-3">
        {hidden > 0 && (
          <li>
            <button className="text-xs text-muted underline" onClick={() => setAll(true)}>
              Show {hidden} earlier {hidden === 1 ? "step" : "steps"}
            </button>
          </li>
        )}
        {shown.map((e) => (
          <li
            key={e.id}
            className={`flex items-baseline gap-3 text-sm ${e.depth > 0 ? "ml-6" : ""}`}
          >
            <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${toneBg[TONE[e.kind]]}`} />
            <span
              className={`min-w-0 flex-1 break-words ${
                e.kind === "step" || e.kind === "started" ? "text-muted" : toneText[TONE[e.kind]]
              }`}
            >
              {e.text}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted">
              {sinceStart(start, new Date(e.at).getTime())}
            </span>
          </li>
        ))}
        {live.active && (
          <li className="pl-4 text-xs text-muted" aria-hidden="true">
            …
          </li>
        )}
      </ol>
    </section>
  );
}

/** Polls while a run is going; the console's event stream also refreshes it the moment it moves. */
export function LiveRun({ jobId }: { jobId: string }) {
  const live = useQuery({
    queryKey: ["live", jobId],
    queryFn: () => api<LiveRunT>(`/jobs/${jobId}/live`),
    refetchInterval: (query) => (query.state.data?.active === true ? 2_000 : false),
  });
  if (live.data === undefined) return null;
  return <LiveRunView live={live.data} />;
}
