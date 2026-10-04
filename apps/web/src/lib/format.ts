import type { Decision, PaymentState } from "./api.js";

export type Tone = "paid" | "held" | "needs" | "stuck" | "blocked" | "muted";

/** Plain words for ledger states (docs/DESIGN.md: Paid, Held, Needs you, Stuck, Blocked). */
export function statusOf(d: Pick<Decision, "result" | "state">): { word: string; tone: Tone } {
  if (d.result === "DENIED") return { word: "Blocked", tone: "blocked" };
  const map: Record<PaymentState, { word: string; tone: Tone }> = {
    PENDING_APPROVAL: { word: "Needs you", tone: "needs" },
    RESERVED: { word: "Held", tone: "held" },
    RELEASING: { word: "Held", tone: "held" },
    FUNDED_WALLET: { word: "Held", tone: "held" },
    SIGNING: { word: "Held", tone: "held" },
    UNRESOLVED: { word: "Stuck", tone: "stuck" },
    SETTLED: { word: "Paid", tone: "paid" },
    RELEASED: { word: "Returned", tone: "muted" },
    REJECTED: { word: "Rejected", tone: "muted" },
  };
  return d.state === null ? { word: "Held", tone: "held" } : map[d.state];
}

export const toneText: Record<Tone, string> = {
  paid: "text-paid",
  held: "text-held",
  needs: "text-needs",
  stuck: "text-stuck",
  blocked: "text-blocked",
  muted: "text-muted",
};

export const toneBg: Record<Tone, string> = {
  paid: "bg-paid",
  held: "bg-held",
  needs: "bg-needs",
  stuck: "bg-stuck",
  blocked: "bg-blocked",
  muted: "bg-muted",
};

/** Why a request was blocked, in a few words. */
export const blockedBecause: Record<string, string> = {
  JOB_NOT_ACTIVE: "Job paused",
  JOB_EXPIRED: "Job expired",
  AGENT_NOT_IN_JOB: "Wrong job",
  AGENT_REVOKED: "Agent revoked",
  INVALID_AMOUNT: "Invalid amount",
  PAYEE_NOT_ALLOWED: "Seller not allowed",
  PER_TX_CAP_EXCEEDED: "Over per-payment cap",
  AGENT_LIMIT_EXCEEDED: "Over agent limit",
  CATEGORY_BUDGET_EXCEEDED: "Over category limit",
  JOB_BUDGET_EXCEEDED: "Over budget",
  JOB_UNDERFUNDED: "Not enough funded",
  RATE_LIMITED: "Too many, too fast",
};

/** What a decision was for: the invoice, the resource bought, or the payee's name. */
export function whatFor(
  d: Pick<Decision, "kind" | "invoiceRef" | "paymentUrl" | "payeeLabel" | "payee">,
) {
  if (d.kind === "INVOICE") return `Invoice ${d.invoiceRef ?? ""}`.trim();
  if (d.paymentUrl !== null) {
    const last = new URL(d.paymentUrl).pathname.split("/").filter(Boolean).at(-1);
    if (last !== undefined) return capitalise(last.replace(/[-_]/g, " "));
  }
  return d.payeeLabel ?? shortPayee(d.payee);
}

export function shortPayee(payee: string) {
  if (/^0x[0-9a-f]{40}$/i.test(payee)) return shortAddress(payee);
  try {
    return new URL(payee).host;
  } catch {
    return payee;
  }
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const shortHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function time(iso: string) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "0.1" → "0.10". Amounts arrive as USDC decimal strings. */
export function money(value: string) {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

/**
 * The twelve rules every request is checked against, in the order they run, each in plain words
 * for when it passes and when it stops the request (the check names are the API's).
 */
export const ruleLines: Record<string, { pass: string; fail: string }> = {
  JOB_NOT_ACTIVE: { pass: "The job is open", fail: "The job is paused" },
  JOB_EXPIRED: { pass: "The job hasn't expired", fail: "The job has expired" },
  AGENT_NOT_IN_JOB: { pass: "The agent works on this job", fail: "The agent isn't on this job" },
  AGENT_REVOKED: { pass: "The agent's key is active", fail: "The agent's key was revoked" },
  INVALID_AMOUNT: { pass: "The amount is valid", fail: "The amount isn't valid" },
  PAYEE_NOT_ALLOWED: { pass: "The seller is allowed", fail: "The seller isn't allowed" },
  PER_TX_CAP_EXCEEDED: { pass: "Within the per-payment cap", fail: "Over the per-payment cap" },
  AGENT_LIMIT_EXCEEDED: {
    pass: "Within the agent's own limit",
    fail: "Over the agent's own limit",
  },
  CATEGORY_BUDGET_EXCEEDED: { pass: "Within the category limit", fail: "Over the category limit" },
  JOB_BUDGET_EXCEEDED: { pass: "Within the job's budget", fail: "Over the job's budget" },
  JOB_UNDERFUNDED: { pass: "The vault holds enough", fail: "The vault doesn't hold enough" },
  RATE_LIMITED: { pass: "Not too many, too fast", fail: "Too many, too fast" },
};

/** The word stamped on a voucher, and the headline over it. */
export function verdictOf(d: Pick<Decision, "result" | "state">): {
  stamp: string;
  headline: string;
  tone: Tone;
} {
  if (d.result === "DENIED")
    return { stamp: "BLOCKED", headline: "Why it was stopped", tone: "blocked" };
  switch (d.state) {
    case "SETTLED":
      return { stamp: "PAID", headline: "Why it went through", tone: "paid" };
    case "PENDING_APPROVAL":
      return { stamp: "NEEDS YOU", headline: "Why it's waiting for you", tone: "needs" };
    case "UNRESOLVED":
      return { stamp: "STUCK", headline: "Why it's on hold", tone: "stuck" };
    case "RELEASED":
      return { stamp: "RETURNED", headline: "Why the money came back", tone: "muted" };
    case "REJECTED":
      return { stamp: "REJECTED", headline: "Why it was turned down", tone: "muted" };
    default:
      return { stamp: "HELD", headline: "Why it's on its way", tone: "held" };
  }
}
