import { config } from "./config.js";

const SESSION_KEY = "bursar.session";

export interface Session {
  readonly key: string;
  readonly role: "OWNER" | "APPROVER";
  readonly wallet: string;
  readonly ownerId: string;
  readonly expiresAt: string;
}

/**
 * The session key lives in localStorage, and is only ever sent in the Authorization header to our
 * own API (never cookies, so no cross-site request can use it). It expires after 24 hours.
 */
export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw === null) return null;
    const session = JSON.parse(raw) as Session;
    return new Date(session.expiresAt).getTime() > Date.now() ? session : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session | null) {
  try {
    if (session === null) localStorage.removeItem(SESSION_KEY);
    else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Private mode: the session lasts for this tab only.
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Called when the API says the session is gone, so the app can go back to sign-in. */
let onSignedOut: () => void = () => undefined;
export function whenSignedOut(handler: () => void) {
  onSignedOut = handler;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}) {
  const session = loadSession();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (session !== null) headers.authorization = `Bearer ${session.key}`;
  const response = await fetch(`${config.apiUrl}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401 && session !== null) onSignedOut();
    throw new ApiError(
      response.status,
      String(json.error ?? "HTTP_ERROR"),
      String(json.message ?? `Request failed (${response.status})`),
    );
  }
  return json as T;
}

/** Shapes the console reads. Money is always a USDC decimal string, e.g. "0.02". */
export interface Job {
  id: string;
  title: string;
  customer: string | null;
  status: "DRAFT" | "PENDING_CHAIN" | "ACTIVE" | "PAUSED" | "CLOSED";
  budget: string;
  deposited: string;
  settled: string;
  reserved: string;
  pendingApproval: string;
  unresolved: string;
  remaining: string;
  revenueReceived: string;
  aiCost: string;
  profit: string;
  perTxCap: string;
  approvalThreshold: string;
  windowCap: string;
  windowSeconds: number;
  expiresAt: string;
  delegationAllowed: boolean;
  frozenReason: string | null;
  brief: string | null;
  operatorRunAt: string | null;
  onChain: { vaultJobId: string | null; agentWallet: string | null; policyVersion: number };
  /** Circle Gateway float for nano payments (absent from older API responses). */
  gateway?: { funded: string; drawn: string; available: string; returned: string };
  agents?: number;
  needsYou?: number;
}

export type PaymentState =
  | "PENDING_APPROVAL"
  | "RESERVED"
  | "RELEASING"
  | "FUNDED_WALLET"
  | "SIGNING"
  | "UNRESOLVED"
  | "SETTLED"
  | "RELEASED"
  | "REJECTED";

/** One run of Bursar's own AI operator: what it was asked, and its answer. */
export interface Run {
  id: string;
  at: string;
  outcome: string;
  /** Written by a model that read seller content: shown as plain text. */
  summary: string | null;
  brief: string;
  steps: number;
  model: string;
  /** The AI model's cost in USD. */
  aiCost: string;
}

export interface Decision {
  id: string;
  at: string;
  agent: { id: string; name: string; role: string };
  kind: "PURCHASE" | "INVOICE";
  payee: string;
  payeeLabel: string | null;
  invoiceRef: string | null;
  amount: string;
  reasoning: string;
  result: "ALLOWED" | "NEEDS_APPROVAL" | "DENIED";
  reason: string | null;
  state: PaymentState | null;
  authorizationId: string | null;
  paymentUrl: string | null;
  paymentTx: string | null;
  /** VAULT (on-chain per payment) or GATEWAY (Circle Gateway nano payment). */
  rail?: "VAULT" | "GATEWAY" | null;
}

export interface Agent {
  id: string;
  jobId: string;
  name: string;
  role: string;
  parentAgentId: string | null;
  replacesAgentId: string | null;
  replacedByAgentId: string | null;
  status: "ACTIVE" | "REVOKED";
  spendLimit: string | null;
  committed: string;
}

export interface PendingApproval {
  authorizationId: string;
  jobId: string;
  jobTitle: string;
  amount: string;
  payee: string;
  reasoning: string;
  requestedAt: string;
  typedData: unknown;
}
