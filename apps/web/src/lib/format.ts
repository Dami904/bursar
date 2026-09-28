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
