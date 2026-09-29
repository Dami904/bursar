import { ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { useLoop } from "../../lib/motion.js";
import { Flow } from "./Flow.js";
import { WaxSeal } from "./WaxSeal.js";

/** The headline: "your wallet" is struck out, "a budget" is underlined in gold, as it loads. */
export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <Flow />
      <div
        className="animate-glow pointer-events-none absolute right-[8%] top-24 size-[420px] rounded-full bg-seal/30 blur-[110px]"
        aria-hidden="true"
      />
      <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-5 pb-20 pt-16 lg:grid-cols-[1.05fr_1fr] md:pt-24">
        <div>
          <p className="animate-rise mb-5 inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted">
            <span className="size-1.5 rounded-full bg-seal" /> Live on Arc testnet
          </p>
          <h1 className="animate-rise text-5xl font-medium leading-[1.02] tracking-[-0.035em] [animation-delay:80ms] sm:text-6xl">
            Give AI agents{" "}
            <span className="relative whitespace-nowrap">
              a budget,
              <span
                className="absolute -bottom-1 left-0 h-[5px] w-full origin-left rounded-full bg-seal [animation:strike_0.7s_1s_cubic-bezier(.2,.7,.2,1)_both]"
                aria-hidden="true"
              />
            </span>
            <br />
            not{" "}
            <span className="relative whitespace-nowrap text-muted">
              your wallet.
              <span
                className="absolute left-0 top-[55%] h-[4px] w-full origin-left rounded-full bg-blocked [animation:strike_0.5s_1.6s_ease-out_both]"
                aria-hidden="true"
              />
            </span>
          </h1>
          <p className="animate-rise mt-6 max-w-md text-lg text-muted [animation-delay:200ms]">
            Shared spending limits for agent teams. Every payment checked, the big ones approved by
            you, all of it sealed on-chain.
          </p>
          <div className="animate-rise mt-8 flex flex-wrap gap-3 [animation-delay:320ms]">
            <Link
              to="/demo"
              className="group inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 font-medium text-on-accent transition hover:gap-3"
            >
              Try the live demo <ArrowRight size={16} />
            </Link>
            <Link
              to="/docs/quickstart"
              className="inline-flex items-center rounded-full border border-line bg-surface px-6 py-3 font-medium hover:border-muted"
            >
              Read the quickstart
            </Link>
          </div>
        </div>
        <ProductShot />
      </div>
    </section>
  );
}

const rows = [
  { who: "Researcher", what: "Market insight", amount: "0.01", word: "Paid", tone: "text-paid" },
  { who: "Writer", what: "Stock photo", amount: "0.04", word: "Held", tone: "text-held" },
  {
    who: "Operator",
    what: "Premium dataset",
    amount: "5.00",
    word: "Blocked",
    tone: "text-blocked",
  },
];

/**
 * A job card that plays one job's story on a loop: budget ticks down, decisions arrive, a big
 * payment waits, gets approved with a signature, and the log is sealed on Arc.
 */
function ProductShot() {
  // 0 empty · 1–3 rows arrive · 4 needs you · 5 approved · 6 sealed · (hold, then loop)
  const step = useLoop([900, 900, 900, 1400, 1600, 1100, 3200]);
  const left = ["1.00", "0.99", "0.95", "0.95", "0.95", "0.75", "0.75"][step];
  const paid = [0, 1, 1, 1, 1, 21, 21][step] ?? 0;
  const held = [0, 0, 4, 4, 4, 4, 4][step] ?? 0;
  const needs = step === 4 ? 20 : 0;
  return (
    <div className="animate-float relative mx-auto w-full max-w-md" aria-hidden="true">
      {step >= 6 && (
        <div className="animate-stamp absolute -right-6 -top-8 z-10 drop-shadow-xl">
          <WaxSeal size={104} />
        </div>
      )}
      <div className="relative rounded-3xl border border-line bg-surface p-6 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.35)]">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">Explainer film</span>
          <span className="text-xs text-muted">3 agents</span>
        </div>
        <p className="mt-5 text-xs text-muted">Left</p>
        <p className="text-4xl font-medium tabular-nums tracking-tight">
          {left} <span className="text-base font-normal text-muted">USDC</span>
        </p>
        <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-track">
          <span className="bg-paid transition-all duration-700" style={{ width: `${paid}%` }} />
          <span className="bg-held transition-all duration-700" style={{ width: `${held}%` }} />
          <span className="bg-needs transition-all duration-700" style={{ width: `${needs}%` }} />
        </div>
        <div className="mt-5 min-h-[168px] space-y-0">
          {rows.slice(0, Math.min(step, 3)).map((r) => (
            <div
              key={r.what}
              className="animate-slide-in flex items-center justify-between border-t border-line py-2.5 text-sm"
            >
              <span>
                {r.what} <span className="text-xs text-muted">· {r.who}</span>
              </span>
              <span className="flex items-center gap-3">
                <span
                  className={`tabular-nums ${r.word === "Blocked" ? "text-muted line-through" : ""}`}
                >
                  {r.amount}
                </span>
                <span className={`w-14 text-right text-xs font-medium ${r.tone}`}>{r.word}</span>
              </span>
            </div>
          ))}
        </div>
        {step >= 4 && (
          <div
            className={`animate-slide-in mt-2 rounded-2xl border p-4 text-sm ${step === 4 ? "border-needs" : "border-paid"}`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">0.20 → Colourist</span>
              <span className={`text-xs font-medium ${step === 4 ? "text-needs" : "text-paid"}`}>
                {step === 4 ? "Needs you" : "Approved"}
              </span>
            </div>
            <p className="mt-1 font-voice italic text-muted">
              "Scene 2 grade, delivered and checked."
            </p>
            {step >= 5 && (
              <svg viewBox="0 0 160 30" className="mt-1 h-6 w-32" aria-hidden="true">
                <path
                  d="M4 22 C 20 2, 30 30, 44 14 S 70 4, 80 18 S 104 26, 118 10 S 142 8, 156 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  style={{
                    strokeDasharray: 220,
                    strokeDashoffset: 220,
                    animation: "draw 0.9s ease-out forwards",
                  }}
                />
              </svg>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
