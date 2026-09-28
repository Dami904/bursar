import type { ReactNode } from "react";
import type { Job } from "../lib/api.js";
import { money, toneBg, toneText, type Tone } from "../lib/format.js";

/** The b with a coin for its bowl. The stem follows the text colour; the coin is always gold. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect x="14" y="8" width="8" height="48" rx="4" className="fill-ink" />
      <circle cx="36" cy="40" r="14" className="fill-seal" />
    </svg>
  );
}

export function Dot({ tone, className = "" }: { tone: Tone; className?: string }) {
  return (
    <span className={`inline-block size-2 shrink-0 rounded-full ${toneBg[tone]} ${className}`} />
  );
}

export function Status({ word, tone }: { word: string; tone: Tone }) {
  return <span className={`text-xs font-medium ${toneText[tone]}`}>{word}</span>;
}

const toUnits = (value: string) => Math.round(Number(value) * 1_000_000);

/** The job's money at a glance: paid, held, waiting for you, stuck, and what's left. */
export function BudgetBar({ job, legend = true }: { job: Job; legend?: boolean }) {
  const budget = Math.max(toUnits(job.budget), 1);
  const parts: { tone: Tone; value: string; label: string }[] = [
    { tone: "paid", value: job.settled, label: "Paid" },
    { tone: "held", value: job.reserved, label: "Held" },
    { tone: "needs", value: job.pendingApproval, label: "Needs you" },
    { tone: "stuck", value: job.unresolved, label: "Stuck" },
  ];
  return (
    <div>
      <div
        className="flex h-2 overflow-hidden rounded-full bg-track"
        role="img"
        aria-label={`${money(job.remaining)} of ${money(job.budget)} USDC left`}
      >
        {parts.map((p) => (
          <span
            key={p.tone}
            className={toneBg[p.tone]}
            style={{ width: `${(toUnits(p.value) / budget) * 100}%` }}
          />
        ))}
      </div>
      {legend && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          {parts
            // Paid is always shown; the rest only when there's something in them.
            .filter((p) => toUnits(p.value) > 0 || p.tone === "paid")
            .map((p) => (
              <span key={p.tone} className="flex items-center gap-1.5">
                <Dot tone={p.tone} /> {p.label} {money(p.value)}
              </span>
            ))}
        </div>
      )}
    </div>
  );
}

export function Button({
  children,
  primary = false,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition active:scale-[0.98] disabled:opacity-50 ${
        primary ? "bg-accent text-on-accent" : "border border-line hover:bg-surface"
      } ${className}`}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-line bg-surface p-4 ${className}`}>{children}</div>
  );
}

export function Loading() {
  return <div className="py-16 text-center text-sm text-muted">Loading…</div>;
}

export function ErrorLine({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  const message = error instanceof Error ? error.message.split("\n")[0] : "Something went wrong";
  return <p className="text-sm text-blocked">{message}</p>;
}

export function Initial({ name }: { name: string }) {
  return (
    <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-track text-[11px] font-medium">
      {name.charAt(0).toUpperCase()}
    </span>
  );
}
