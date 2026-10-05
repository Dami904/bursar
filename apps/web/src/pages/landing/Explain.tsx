import { Ban, ChevronDown, Clock, Gauge, ListChecks, Timer, UserCheck, Users } from "lucide-react";
import { Link } from "react-router";
import { DemoLink, Perforation } from "../../components/ui.js";
import { useInView } from "../../lib/motion.js";
import { SectionTitle } from "./Sections.js";

/**
 * The one rule, as a strip of receipt tape: the budget, minus everything already committed, equals
 * what is left, and a request that would take "left" below zero never starts.
 */
export function OneRule() {
  const { ref, inView } = useInView<HTMLDivElement>(0.3);
  const rows: { label: string; value: string; tone?: string }[] = [
    { label: "Budget", value: "1.00" },
    { label: "− paid", value: "0.40", tone: "text-paid" },
    { label: "− held for a payment on its way", value: "0.40", tone: "text-held" },
    { label: "− waiting for your approval", value: "0.00", tone: "text-needs" },
    { label: "− stuck, outcome unknown", value: "0.00", tone: "text-stuck" },
  ];
  return (
    <section className="mx-auto grid max-w-6xl items-center gap-14 overflow-x-clip px-5 py-28 md:grid-cols-2">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-seal">The one rule</p>
        <h2 className="mt-3 text-4xl font-medium tracking-[-0.03em] sm:text-5xl">
          What's committed never passes what's funded.
        </h2>
        <p className="mt-5 max-w-md text-lg text-muted">
          Paid, held, waiting and stuck all count as spent. Every agent on a job, helpers and
          replacements too, draws from the same line, and a request that would cross it is turned
          down before any money moves.
        </p>
        <p className="mt-6 font-mono text-sm text-ink">paid + held + waiting + stuck ≤ budget</p>
      </div>

      <div
        ref={ref}
        className="relative mx-auto w-full max-w-sm [filter:drop-shadow(0_6px_14px_rgb(0_0_0/0.14))]"
      >
        <Perforation />
        <div className="bg-surface px-7 pb-7 pt-3 font-mono text-sm">
          <p className="text-center text-[11px] uppercase tracking-[0.3em] text-muted">
            Job tape · 1.00 USDC
          </p>
          <ul className="mt-5 space-y-2">
            {rows.map((r, i) => (
              <li
                key={r.label}
                className={`reveal ${inView ? "in" : ""} flex items-baseline gap-2`}
                style={{ animationDelay: `${i * 280}ms` }}
              >
                <span className={r.tone ?? "text-ink"}>{r.label}</span>
                <span className="min-w-3 flex-1 translate-y-[-3px] border-b border-dotted border-line" />
                <span className="tabular-nums">{r.value}</span>
              </li>
            ))}
          </ul>
          <div
            className={`reveal ${inView ? "in" : ""} mt-4 flex items-baseline gap-2 border-t-2 border-ink pt-3 text-base font-medium`}
            style={{ animationDelay: "1500ms" }}
          >
            <span>Left to spend</span>
            <span className="min-w-3 flex-1 translate-y-[-3px] border-b border-dotted border-line" />
            <span className="tabular-nums">0.20</span>
          </div>
          <p
            className={`reveal ${inView ? "in" : ""} mt-5 text-center`}
            style={{ animationDelay: "1900ms" }}
          >
            <span className="animate-stamp inline-block max-w-full rounded-md border-2 border-seal px-3 py-1 text-[11px] tracking-[0.12em] text-seal-text [animation-delay:2s] sm:tracking-[0.25em]">
              CHECKED BEFORE MONEY MOVES
            </span>
          </p>
        </div>
        <Perforation bottom />
      </div>
    </section>
  );
}

const CONTROLS = [
  {
    icon: Gauge,
    title: "Per-payment cap",
    body: "No single payment above it, whoever asks.",
    figure: "≤ 0.50",
  },
  {
    icon: UserCheck,
    title: "Approval threshold",
    body: "Above it, a person signs from their own wallet.",
    figure: "> 0.10 → you",
  },
  {
    icon: ListChecks,
    title: "Allow-list",
    body: "Sellers and vendors by name, or a whole marketplace up to a price.",
    figure: "3 sellers",
  },
  {
    icon: Clock,
    title: "Expiry",
    body: "The job closes itself on the date you set.",
    figure: "7 days",
  },
  {
    icon: Users,
    title: "Agent limits",
    body: "Each agent gets its own ceiling inside the job.",
    figure: "0.30 each",
  },
  {
    icon: Timer,
    title: "Spend per hour",
    body: "A runaway loop hits a wall before it hits the budget.",
    figure: "0.40 / h",
  },
  {
    icon: Ban,
    title: "Revoke",
    body: "Turn off one agent or the whole job, at once.",
    figure: "1 click",
  },
] as const;

/** Everything the owner sets, as a grid: one large tile for the budget, a small one for each other control. */
export function Controls() {
  const { ref, inView } = useInView<HTMLDivElement>(0.2);
  return (
    <section className="mx-auto max-w-6xl px-5 py-28">
      <SectionTitle
        kicker="What you control"
        title="Everything an agent can't do on its own."
        sub="You set these once. They apply to every agent on the job, and the agent can't change any of them."
      />
      <div ref={ref} className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <article
          className={`reveal ${inView ? "in" : ""} flex flex-col justify-between rounded-2xl border border-line bg-surface p-6 sm:col-span-2 lg:row-span-2`}
        >
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-seal">The budget</p>
            <h3 className="mt-3 text-2xl font-medium">One number per job, held in a vault.</h3>
            <p className="mt-3 max-w-sm text-muted">
              Not in a wallet an agent can reach. Money leaves only for a payment the rules allowed,
              and what's left stays yours.
            </p>
          </div>
          <div className="mt-8">
            <p className="font-mono text-5xl tracking-tight">
              0.20 <span className="text-lg text-muted">left of 1.00</span>
            </p>
            <div
              className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-track"
              aria-hidden="true"
            >
              <span className="bg-paid" style={{ width: "40%" }} />
              <span className="bg-held" style={{ width: "40%" }} />
            </div>
            <p className="mt-2 flex gap-4 text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-paid" /> Paid 0.40
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-held" /> Held 0.40
              </span>
            </p>
          </div>
        </article>
        {CONTROLS.map((c, i) => (
          <article
            key={c.title}
            className={`reveal ${inView ? "in" : ""} flex flex-col rounded-2xl border border-line bg-surface p-5`}
            style={{ animationDelay: `${(i + 1) * 90}ms` }}
          >
            <c.icon size={18} className="text-seal" aria-hidden="true" />
            <h3 className="mt-3 font-medium">{c.title}</h3>
            <p className="mt-1 flex-1 text-sm text-muted">{c.body}</p>
            <p className="mt-4 w-fit rounded-md bg-track px-2 py-1 font-mono text-xs">{c.figure}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

const BREAKS = [
  {
    title: "Three agents, one balance",
    wrong:
      "Each one looks, sees 1.00, and spends 0.40. All three decisions were reasonable. Together they spent 1.20.",
    answer: "Held first",
    detail:
      "The amount is set aside the moment a request is allowed. The third agent sees 0.20 left and is told no.",
  },
  {
    title: "A retry that pays twice",
    wrong:
      "A payment timed out, so the agent tried again. The seller had already been paid the first time.",
    answer: "Same request, same answer",
    detail:
      "Every request carries its own ID. Asking again returns the first decision and the same signed payment, never a second one.",
  },
  {
    title: "A crash halfway through",
    wrong:
      "The worker stopped after signing and nobody knows if the seller got it. Release the money and it might be paid twice.",
    answer: "Held until it's provable",
    detail:
      "An unclear payment stays counted as spent, marked stuck, until Bursar can show it was paid or that it can no longer be. Then the money moves, or comes home.",
  },
] as const;

/** Three ways shared budgets fail, each answered the way the ledger answers it. */
export function WhereItBreaks() {
  const { ref, inView } = useInView<HTMLDivElement>(0.2);
  return (
    <section className="border-y border-line bg-surface py-28">
      <SectionTitle
        kicker="Where shared budgets break"
        title="Three failures, three answers."
        sub="None of these are rare. Any team running more than one agent hits them within days."
      />
      <div ref={ref} className="mx-auto mt-16 grid max-w-6xl gap-6 px-5 md:grid-cols-3">
        {BREAKS.map((b, i) => (
          <article
            key={b.title}
            className={`reveal ${inView ? "in" : ""} flex flex-col rounded-2xl border border-line bg-bg p-6`}
            style={{ animationDelay: `${i * 200}ms` }}
          >
            <p className="font-mono text-xs text-muted">0{i + 1}</p>
            <h3 className="mt-2 text-xl font-medium">{b.title}</h3>
            <p className="mt-3 flex-1 font-voice text-base italic leading-snug text-muted">
              {b.wrong}
            </p>
            <div className="mt-6 border-t border-dotted border-line pt-4">
              <span className="inline-block -rotate-2 rounded-md border-2 border-paid px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.18em] text-paid">
                {b.answer}
              </span>
              <p className="mt-3 text-sm text-muted">{b.detail}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

const TRACK = [
  { word: "Asked", note: "An agent wants to pay", tone: "bg-ink text-bg" },
  { word: "Checked", note: "Twelve rules, one answer", tone: "bg-ink text-bg" },
  { word: "Held", note: "The amount is set aside", tone: "bg-held text-on-accent" },
  { word: "Paid", note: "Confirmed on Arc", tone: "bg-paid text-on-accent" },
] as const;

const EXITS = [
  {
    word: "Blocked",
    note: "A rule said no. No money moved.",
    color: "border-blocked text-blocked",
  },
  {
    word: "Needs you",
    note: "Above your threshold: you approve, it carries on.",
    color: "border-needs text-needs",
  },
  {
    word: "Stuck",
    note: "Outcome unclear. Still counted until it's proven.",
    color: "border-stuck text-stuck",
  },
  {
    word: "Returned",
    note: "Proven unpaid. The money goes back to the vault.",
    color: "border-line text-muted",
  },
] as const;

/** A payment's life as a track with four stops and four side exits, in the words the console uses. */
export function PaymentLife() {
  const { ref, inView } = useInView<HTMLDivElement>(0.3);
  return (
    <section className="mx-auto max-w-6xl px-5 py-28">
      <SectionTitle
        kicker="A payment's life"
        title="Every request ends in one of these words."
        sub="The same words appear in the console, on every voucher, and in the audit log."
      />
      <div ref={ref} className="mt-16">
        <ol className="relative grid gap-8 md:grid-cols-4">
          <div
            className={`absolute left-[12.5%] right-[12.5%] top-5 hidden h-px origin-left bg-seal md:block ${inView ? "[animation:strike_1.6s_ease-out_both]" : "scale-x-0"}`}
            aria-hidden="true"
          />
          {TRACK.map((t, i) => (
            <li
              key={t.word}
              className={`reveal ${inView ? "in" : ""} relative text-center`}
              style={{ animationDelay: `${i * 220}ms` }}
            >
              <span
                className={`relative mx-auto flex size-10 items-center justify-center rounded-full text-sm font-medium ${t.tone}`}
              >
                {i + 1}
              </span>
              <p className="mt-3 text-lg font-medium">{t.word}</p>
              <p className="mx-auto mt-1 max-w-[12rem] text-sm text-muted">{t.note}</p>
            </li>
          ))}
        </ol>
        <p className="mt-14 text-center text-xs font-medium uppercase tracking-[0.2em] text-muted">
          Or it leaves the track
        </p>
        <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {EXITS.map((x, i) => (
            <li
              key={x.word}
              className={`reveal ${inView ? "in" : ""} rounded-xl border-2 border-dashed p-4 ${x.color}`}
              style={{ animationDelay: `${900 + i * 160}ms` }}
            >
              <p className="font-medium">{x.word}</p>
              <p className="mt-1 text-sm text-muted">{x.note}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const FAQ: { group: string; items: { q: string; a: React.ReactNode }[] }[] = [
  {
    group: "Your money",
    items: [
      {
        q: "Where does the money sit?",
        a: "In a vault contract on Arc, one balance per job. Only what a payment needs leaves it, and only when the rules allow that payment. Whatever isn't spent stays under the owner's control.",
      },
      {
        q: "Does an agent hold a wallet key?",
        a: "No. An agent holds a Bursar key. It can ask to spend and look at its budget, but it can't sign a payment or move money. Each purchase is signed by the job's own Circle-managed wallet for the exact amount that was allowed, and invoices are paid by the vault itself.",
      },
      {
        q: "Is this real money?",
        a: "There are two consoles. Testnet uses test USDC with no value. Mainnet moves real USDC on Arc, and while it's new each job there is capped at 5 USDC.",
      },
    ],
  },
  {
    group: "When things go wrong",
    items: [
      {
        q: "What if a payment times out?",
        a: "It's marked stuck and keeps counting against the budget. Bursar never assumes a timeout means nothing was paid. It looks at the chain and at Circle, then settles it or sends the money back.",
      },
      {
        q: "Can a retry charge twice?",
        a: "No. Every request has an ID, and a retry gets the first decision back with the same signed payment. A seller that sees it twice can only be paid once.",
      },
      {
        q: "What about sellers that deliver later?",
        a: "Image and video sellers take the order, then hand back a ticket. Bursar collects the result with the same payment, so you pay once, when it's ready. If it never is, the payment is held until it expires and then returned.",
      },
    ],
  },
  {
    group: "Trust",
    items: [
      {
        q: "How do I check Bursar did what it says?",
        a: "Every decision goes into a hash-chained log whose head is sealed on Arc. Each voucher has a Verify button that re-checks the hashes in your own browser, with nothing taken on trust.",
      },
      {
        q: "What stops an agent being talked into paying someone?",
        a: "The allow-list, the caps and the budget don't read the agent's reasoning. A seller's text is shown to the model as untrusted, and a marketplace purchase can't cost more than your per-call limit (or the listed price, if you set none).",
      },
      {
        q: "What does revoking an agent do?",
        a: "Its key stops working at once, and anything it asked for afterwards is refused. Payments already held stay on the ledger, because taking away authority doesn't un-spend money.",
      },
    ],
  },
];

/** Questions a first-time visitor has, grouped, with an index that stays in view. */
export function Faq() {
  return (
    <section className="border-t border-line bg-surface py-28" id="faq">
      <div className="mx-auto grid max-w-6xl gap-12 px-5 md:grid-cols-[14rem_1fr]">
        <div className="md:sticky md:top-28 md:self-start">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-seal">Questions</p>
          <h2 className="mt-3 text-4xl font-medium tracking-[-0.03em]">
            Asked before, answered plainly.
          </h2>
          <nav className="mt-6 hidden flex-col gap-2 text-sm md:flex" aria-label="Question groups">
            {FAQ.map((g) => (
              <a
                key={g.group}
                href={`#faq-${g.group.toLowerCase().replace(/\W+/g, "-")}`}
                className="text-muted hover:text-ink"
              >
                {g.group}
              </a>
            ))}
          </nav>
          <p className="mt-8 text-sm text-muted">
            Still unsure?{" "}
            <Link to="/docs/introduction" className="text-ink underline">
              Read the docs
            </Link>{" "}
            or <DemoLink className="text-ink underline">watch a live job</DemoLink>.
          </p>
        </div>
        <div className="space-y-12">
          {FAQ.map((g) => (
            <div key={g.group} id={`faq-${g.group.toLowerCase().replace(/\W+/g, "-")}`}>
              <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted">
                {g.group}
              </h3>
              <div className="mt-3 border-t border-line">
                {g.items.map((item) => (
                  <details key={item.q} className="group border-b border-line">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-lg font-medium [&::-webkit-details-marker]:hidden">
                      {item.q}
                      <ChevronDown
                        size={18}
                        className="shrink-0 text-muted transition group-open:rotate-180"
                      />
                    </summary>
                    <p className="max-w-2xl pb-5 text-muted">{item.a}</p>
                  </details>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
