import { MoneyError, parseUsdc } from "@bursar/money";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { bearerKey, type Role } from "./auth/keys.js";
import { resolvePrincipal, type Principal } from "./auth/principal.js";
import {
  authorizations,
  computeMetrics,
  jobs,
  LedgerError,
  operatorRuns,
  owners,
  payees,
  type Db,
} from "@bursar/db";
import {
  QuoteError,
  UnsafeUrlError,
  MARKETPLACES,
  MarketplaceError,
  discover,
  findListing,
  listingsOf,
  paidRequest,
  quote,
  searchListings,
  type Listing,
  type MarketplaceFilters,
  type CatalogEntry,
  type WalletProvider,
} from "@bursar/payments";
import { HttpError, badRequest, forbidden, notFound, unauthorized } from "./http/errors.js";
import {
  DEFAULT_RATE_LIMITS,
  RateLimitedError,
  RateLimiter,
  clientIp,
  type RateLimitConfig,
} from "./http/rate-limit.js";
import { agentView, authorizationView, decisionView, jobView } from "./http/views.js";
import { createAgent, replaceAgent, revokeAgent, spawnSubagent } from "./services/agents.js";
import { gatewayAboveApproval } from "./services/gateway-limit.js";
import { addPayee, createJob, getOwnedJob, setCategoryLimit } from "./services/jobs.js";
import { approve, createApprover, listPending, reject } from "./services/approvals.js";
import {
  addWebhook,
  listTargets,
  recentAlerts,
  removeTarget,
  sendTest,
  telegramLink,
} from "./services/alerts.js";
import { auditStatus, jobAuditTrail } from "./services/audit.js";
import { newNonce, signIn, signOut, type SiweConfig } from "./services/auth.js";
import {
  closeTxOf,
  decisionEvidence,
  jobAgents,
  jobDecisions,
  ownerActivity,
  ownerJobEvents,
  jobPayees,
  jobRuns,
  listJobs,
  runResult,
  marketplaceFilters,
  ownerFingerprint,
} from "./services/console.js";
import { normalizePayee } from "./services/payees.js";
import { committedOf, requestSpend, type SpendResult } from "./services/spend.js";
import { formatUsdc } from "@bursar/money";

type Env = { Variables: { principal: Principal } };

const usdcAmount = z.string().transform((text, ctx) => {
  try {
    return parseUsdc(text);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof MoneyError ? error.message : "Invalid amount",
    });
    return z.NEVER;
  }
});

const createJobBody = z.object({
  title: z.string().min(1).max(200),
  customer: z.string().min(1).max(200),
  budget: usdcAmount,
  perTxCap: usdcAmount,
  approvalThreshold: usdcAmount,
  windowCap: usdcAmount,
  windowSeconds: z.number().int().min(60).max(86_400).default(3600),
  expiresAt: z.iso.datetime().transform((s) => new Date(s)),
  delegationAllowed: z.boolean().default(true),
  /** What the AI operator should do; set, and the operator starts when the job goes live. */
  brief: z.string().min(1).max(4000).optional(),
});

const payeeBody = z.object({
  kind: z.enum(["X402_ORIGIN", "ADDRESS", "MARKETPLACE"]),
  value: z.string().min(1).max(500),
  label: z.string().max(200).optional(),
  category: z.string().min(1).max(64).optional(),
  /** MARKETPLACE only: limit it to some of its categories, and a most-per-call price. */
  filters: z
    .object({
      categories: z.array(z.string().min(1).max(64)).max(20).optional(),
      maxPrice: usdcAmount.optional(),
    })
    .optional(),
});

/** A stored marketplace entry's filters, in the form the matching code takes. */
function filtersOf(stored: unknown): MarketplaceFilters {
  if (stored === null || typeof stored !== "object") return {};
  const f = stored as { categories?: unknown; maxPrice?: unknown };
  return {
    categories: Array.isArray(f.categories) ? f.categories.map(String) : undefined,
    maxPrice:
      typeof f.maxPrice === "string" && /^\d+$/.test(f.maxPrice) ? BigInt(f.maxPrice) : undefined,
  };
}

/** What an agent sees of a listing: the price as USDC, and nothing it could mistake for a rule. */
function listingView(marketplace: string, l: Listing) {
  return {
    marketplace,
    service: l.service,
    provider: l.provider,
    category: l.category,
    method: l.method,
    url: l.url,
    price: formatUsdc(l.price),
    description: l.description,
  };
}

const replaceBody = z.object({
  name: z.string().min(1).max(100),
  role: z.string().min(1).max(100).optional(),
  spendLimit: usdcAmount.optional(),
});

const agentBody = z.object({
  name: z.string().min(1).max(100),
  role: z.string().min(1).max(100),
  spendLimit: usdcAmount.optional(),
});

const spendBody = z.object({
  operationId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,128}$/, "8-128 characters: letters, digits, _ or -"),
  kind: z.enum(["PURCHASE", "INVOICE"]).default("PURCHASE"),
  payee: z.object({ kind: z.enum(["X402_ORIGIN", "ADDRESS"]), value: z.string().min(1).max(500) }),
  amount: usdcAmount,
  reasoning: z.string().min(1).max(4000),
});

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("The request body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  return parsed.data;
}

const invoiceBody = z.object({
  operationId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,128}$/, "8-128 characters: letters, digits, _ or -"),
  /** The vendor's wallet address; it must be on the job's allow-list. */
  payee: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address"),
  amount: usdcAmount,
  /** The vendor's own reference, e.g. an invoice number. */
  invoiceRef: z.string().min(1).max(200),
  reasoning: z.string().min(1).max(4000),
});

/** Some sellers (search, scraping) take a JSON body and answer POST. GET is the default. */
const requestShape = {
  method: z.enum(["GET", "POST"]).default("GET"),
  body: z.record(z.string(), z.unknown()).optional(),
};

/** The request the agent asked for, or a 422 saying why it isn't one. */
function requested(input: { method: "GET" | "POST"; body?: Record<string, unknown> | undefined }) {
  try {
    return paidRequest(input.method, input.body);
  } catch (error) {
    if (error instanceof QuoteError) throw new HttpError(422, "QUOTE_FAILED", error.message);
    throw error;
  }
}

const purchaseBody = z.object({
  operationId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,128}$/, "8-128 characters: letters, digits, _ or -"),
  url: z.string().url().max(2000),
  ...requestShape,
  /** The most the agent is willing to pay; the quote must not exceed it. */
  maxPrice: usdcAmount,
  reasoning: z.string().min(1).max(4000),
});

export interface ApiDeps {
  /** Creates each job's wallet. Omitted in tests that don't need one. */
  readonly wallets?: WalletProvider;
  readonly payments?: {
    /** CAIP-2 network, e.g. "eip155:5042002". */
    readonly network: string;
    readonly asset: string;
    /** Local development only: allow sellers on 127.0.0.1. */
    readonly allowPrivateHosts: boolean;
    /** How long POST /spend/purchase waits for settlement before answering 202. */
    readonly waitMs: number;
  };
  /** The vault approvals are signed for. */
  readonly chain?: { readonly chainId: number; readonly vault: `0x${string}` };
  /** Browser origins allowed to call the API (the console), e.g. "http://localhost:5173". */
  readonly webOrigins?: readonly string[];
  /** Telegram bot for alerts (its @username); omitted: Telegram linking is off. */
  readonly telegramBot?: string | undefined;
  /** Wallet sign-in. Omitted: only API keys work. */
  readonly siwe?: SiweConfig;
  /** How often the live stream checks for changes. */
  readonly streamPollMs?: number;
  /**
   * The public demo job: readable by anyone at /demo, read-only. Only this one job; every other
   * job still needs its owner's key. It's our own business's job, so its data is ours to show.
   */
  readonly demoJobId?: string | undefined;
  /** Whether Bursar's own AI operator runs on this server (a model key, autopilot on). */
  readonly operatorAvailable?: boolean;
  /** The most any one job may have as its budget (mainnet, while it's new). No cap when unset. */
  readonly maxJobBudget?: bigint;
  /** One JSON line per request (method, path, status, time). Off in tests. */
  readonly logRequests?: boolean;
  /** Request limits; false turns them off. Default: DEFAULT_RATE_LIMITS. */
  readonly rateLimits?: RateLimitConfig | false;
  /** Behind a proxy (Render): client IPs come from its forwarding headers. */
  readonly trustProxy?: boolean;
}

function logLine(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: "api",
    msg,
    ...fields,
  });
  (level === "info" ? process.stdout : process.stderr).write(`${line}
`);
}

/** Calls that spend or can lead to spending: limited more tightly per key. */
const SPEND_PATHS = new Set([
  "/spend/request",
  "/spend/invoice",
  "/spend/purchase",
  "/spend/quote",
  "/spend/subagent",
]);

const PUBLIC_PATHS = new Set([
  "/health",
  "/features",
  "/metrics/public",
  "/auth/nonce",
  "/auth/verify",
]);

const signInBody = z.object({
  message: z.string().min(1).max(4000),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

const terminal = new Set(["SETTLED", "RELEASED", "REJECTED", "UNRESOLVED"]);

const runBody = z.object({
  model: z.string().min(1).max(100),
  brief: z.string().min(1).max(4000),
  steps: z.number().int().nonnegative().max(1000),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  /** Model spend in micro-USD, as computed by the operator from token usage. */
  costMicros: z.number().int().nonnegative(),
  outcome: z.enum(["completed", "step_limit", "time_limit", "revoked", "refused", "error"]),
  summary: z.string().max(8000).optional(),
});

function require<R extends Role>(c: Context<Env>, ...roles: R[]): Extract<Principal, { role: R }> {
  const principal = c.get("principal");
  if (!roles.includes(principal.role as R)) throw forbidden(principal.role);
  return principal as Extract<Principal, { role: R }>;
}

export function createApp(db: Db, deps: ApiDeps = {}) {
  const app = new Hono<Env>();

  // Request log: never the query string, headers or body, so keys and secrets can't leak into it.
  // Health checks are skipped: the uptime pinger would drown everything else.
  if (deps.logRequests) {
    app.use("*", async (c, next) => {
      const started = performance.now();
      await next();
      if (c.req.path === "/health" || c.req.method === "OPTIONS") return;
      const status = c.res.status;
      logLine(status >= 500 ? "error" : status >= 400 ? "warn" : "info", "request", {
        method: c.req.method,
        path: c.req.path,
        status,
        ms: Math.round(performance.now() - started),
        role: c.get("principal")?.role ?? null,
      });
    });
  }

  // The console calls the API from the browser. Only listed origins, and keys travel in the
  // Authorization header (never cookies), so there's no cross-site request to forge.
  app.use(
    "*",
    cors({
      origin: [...(deps.webOrigins ?? [])],
      allowHeaders: ["authorization", "content-type"],
      allowMethods: ["GET", "POST", "OPTIONS"],
      maxAge: 600,
    }),
  );

  // Rate limits: per client IP before a key is known, per key after.
  const limits = deps.rateLimits === false ? null : (deps.rateLimits ?? DEFAULT_RATE_LIMITS);
  const limiters =
    limits === null
      ? null
      : {
          signIn: new RateLimiter(limits.signIn),
          public: new RateLimiter(limits.public),
          badKey: new RateLimiter(limits.badKey),
          perKey: new RateLimiter(limits.perKey),
          spend: new RateLimiter(limits.spend),
        };
  const ipOf = (c: Context<Env>) =>
    clientIp((name) => c.req.header(name), deps.trustProxy === true);
  /** Takes a token, or throws 429. Sets the RateLimit headers either way. */
  function limit(c: Context<Env>, limiter: RateLimiter | undefined, key: string) {
    if (limiter === undefined) return;
    const verdict = limiter.take(key);
    c.header("RateLimit-Limit", String(verdict.limit));
    c.header("RateLimit-Remaining", String(verdict.remaining));
    if (!verdict.allowed) throw new RateLimitedError(verdict);
  }

  app.use("*", async (c, next) => {
    if (limiters === null || c.req.method === "OPTIONS" || c.req.path === "/health") {
      return next();
    }
    const path = c.req.path;
    if (path === "/auth/nonce" || path === "/auth/verify") {
      limit(c, limiters.signIn, ipOf(c));
    } else if (path === "/metrics/public" || path === "/demo" || path.startsWith("/demo/")) {
      limit(c, limiters.public, ipOf(c));
    }
    return next();
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  /** Starts a wallet sign-in: a one-time nonce for the message the wallet will sign. */
  app.post("/auth/nonce", async (c) => {
    if (deps.siwe === undefined) throw badRequest("Wallet sign-in isn't enabled on this server");
    return c.json({ nonce: await newNonce(db) });
  });

  /** Finishes a wallet sign-in: checks the signed message and returns a session key. */
  app.post("/auth/verify", async (c) => {
    if (deps.siwe === undefined) throw badRequest("Wallet sign-in isn't enabled on this server");
    const input = await body(c, signInBody);
    return c.json(await signIn(db, deps.siwe, input.message, input.signature));
  });

  /** Traction totals across all businesses, for the landing page. No per-job detail. */
  app.get("/metrics/public", async (c) => {
    const [audit] = (await db.execute(sql`
      select (select coalesce(max(seq), 0) from audit_chain)::int as entries,
             (select count(*) from audit_anchors where status = 'CONFIRMED')::int as anchors`)) as unknown as {
      entries: number;
      anchors: number;
    }[];
    return c.json({
      ...(await computeMetrics(db, null)),
      audit: audit ?? { entries: 0, anchors: 0 },
    });
  });

  app.use("*", async (c, next) => {
    if (
      PUBLIC_PATHS.has(c.req.path) ||
      c.req.path === "/demo" ||
      c.req.path.startsWith("/demo/") ||
      c.req.method === "OPTIONS"
    ) {
      return next();
    }
    // An address that keeps sending bad keys is slowed down before any lookup.
    const ip = ipOf(c);
    if (limiters !== null) {
      const guessing = limiters.badKey.peek(ip);
      if (!guessing.allowed) throw new RateLimitedError(guessing);
    }
    const key = bearerKey(c.req.header("authorization"));
    const principal = key === null ? null : await resolvePrincipal(db, key);
    if (principal === null) {
      limiters?.badKey.take(ip);
      throw unauthorized();
    }
    c.set("principal", principal);
    if (limiters !== null) {
      limit(c, limiters.perKey, principal.credentialId);
      if (SPEND_PATHS.has(c.req.path)) limit(c, limiters.spend, principal.credentialId);
    }
    return next();
  });

  /** Whether a URL's origin is on the job's x402 allow-list. Checked before any outbound request. */
  /**
   * Whether this job may pay the seller at `url`: by name (its origin is on the allow-list), or
   * through an allowed marketplace that lists exactly this endpoint, for this method and our
   * network, within the owner's filters. A marketplace that can't be read allows nothing.
   */
  async function allowListed(jobId: string, url: string, method: "GET" | "POST" = "GET") {
    let origin: string;
    try {
      origin = normalizePayee("X402_ORIGIN", url);
    } catch {
      throw badRequest("url must be an http(s) URL");
    }
    const rows = await db
      .select()
      .from(payees)
      .where(and(eq(payees.jobId, jobId), inArray(payees.kind, ["X402_ORIGIN", "MARKETPLACE"])));
    if (rows.some((r) => r.kind === "X402_ORIGIN" && r.value === origin)) {
      return { origin, allowed: true, via: null };
    }
    const network = deps.payments?.network;
    for (const row of rows) {
      if (row.kind !== "MARKETPLACE" || network === undefined) continue;
      let listings: Listing[];
      try {
        listings = await listingsOf(row.value);
      } catch (error) {
        if (error instanceof MarketplaceError) continue;
        throw error;
      }
      const filters = filtersOf(row.filters);
      const listing = findListing(listings, url, method, network, filters);
      if (listing !== null) {
        return {
          origin,
          allowed: true,
          via: { marketplace: row.value, listing, maxPrice: filters.maxPrice },
        };
      }
    }
    return { origin, allowed: false, via: null };
  }

  // ----- The public demo job (read-only, no key) -----
  async function demoJob() {
    if (deps.demoJobId === undefined) throw notFound("Demo");
    const [job] = await db.select().from(jobs).where(eq(jobs.id, deps.demoJobId));
    if (job === undefined) throw notFound("Demo");
    return job;
  }

  /** What this server offers, for the console to show only what works here. */
  app.get("/features", (c) =>
    c.json({
      operator: deps.operatorAvailable === true,
      maxJobBudget: deps.maxJobBudget === undefined ? null : formatUsdc(deps.maxJobBudget),
    }),
  );

  app.get("/demo", async (c) => {
    const job = await demoJob();
    const [decisionsList, agentsList, payeesList, audit, runs] = await Promise.all([
      jobDecisions(db, job.ownerId, job.id),
      jobAgents(db, job.ownerId, job.id),
      jobPayees(db, job.ownerId, job.id),
      auditStatus(db),
      jobRuns(db, job.ownerId, job.id, 10),
    ]);
    return c.json({
      job: jobView(job),
      runs,
      decisions: decisionsList,
      agents: agentsList,
      payees: payeesList,
      anchor: audit.ok ? audit.latestAnchor : null,
    });
  });

  app.get("/demo/runs/:runId", async (c) => {
    const job = await demoJob();
    // Only the demo job's results are public.
    return c.json(await runResult(db, job.ownerId, job.id, c.req.param("runId")));
  });

  app.get("/demo/decisions/:id", async (c) => {
    const job = await demoJob();
    const evidence = await decisionEvidence(db, job.ownerId, c.req.param("id"));
    // Only the demo job's decisions are public.
    if (evidence.job.id !== job.id) throw notFound("Decision");
    return c.json(evidence);
  });

  /** Who this key belongs to. */
  app.get("/me", async (c) => {
    const who = c.get("principal");
    const [owner] = await db.select().from(owners).where(eq(owners.id, who.ownerId));
    return c.json({
      role: who.role,
      ownerId: who.ownerId,
      ownerName: owner?.name ?? null,
      wallet: owner?.walletAddress ?? null,
    });
  });

  app.post("/auth/logout", async (c) => {
    await signOut(db, c.get("principal").credentialId);
    return c.json({ signedOut: true });
  });

  /**
   * Live updates for the console: an event stream that says "change" whenever anything the owner
   * can see moves (a decision, a payment step, a deposit, an agent). The console then refetches.
   * Read with fetch (the key goes in the Authorization header), not EventSource.
   */
  app.get("/stream", async (c) => {
    const who = require(c, "OWNER", "APPROVER");
    const key = bearerKey(c.req.header("authorization"));
    const pollMs = deps.streamPollMs ?? 2000;
    return streamSSE(c, async (stream) => {
      let open = true;
      stream.onAbort(() => {
        open = false;
      });
      let last = "";
      for (let tick = 0; open; tick += 1) {
        // A revoked or expired session stops receiving updates within ~30 s.
        if (
          tick > 0 &&
          tick % 15 === 0 &&
          (key === null || (await resolvePrincipal(db, key)) === null)
        ) {
          await stream.writeSSE({ event: "signed-out", data: "" });
          break;
        }
        const now = await ownerFingerprint(db, who.ownerId);
        if (now !== last) {
          last = now;
          await stream.writeSSE({ event: "change", data: String(tick) });
        } else if (tick % 10 === 0) {
          await stream.writeSSE({ event: "ping", data: "" });
        }
        await stream.sleep(pollMs);
      }
    });
  });

  // ----- Alerts (owner) -----
  app.get("/alerts", async (c) => {
    const owner = require(c, "OWNER");
    return c.json({
      targets: await listTargets(db, owner.ownerId),
      recent: await recentAlerts(db, owner.ownerId),
      telegram: deps.telegramBot !== undefined,
    });
  });

  /** Adds a webhook. The signing secret is returned once, here. */
  app.post("/alerts/webhooks", async (c) => {
    const owner = require(c, "OWNER");
    const input = await body(c, z.object({ url: z.string().min(1).max(2000) }));
    return c.json(await addWebhook(db, owner.ownerId, input.url), 201);
  });

  app.post("/alerts/targets/:id/remove", async (c) => {
    const owner = require(c, "OWNER");
    await removeTarget(db, owner.ownerId, c.req.param("id"));
    return c.json({ removed: true });
  });

  app.post("/alerts/telegram", async (c) => {
    const owner = require(c, "OWNER");
    if (deps.telegramBot === undefined)
      throw badRequest("Telegram alerts aren't set up on this server");
    return c.json(await telegramLink(db, owner.ownerId, deps.telegramBot));
  });

  app.post("/alerts/test", async (c) => {
    const owner = require(c, "OWNER");
    await sendTest(db, owner.ownerId, deps.webOrigins?.[0] ?? "http://localhost:5173");
    return c.json({ queued: true });
  });

  // ----- Console reads (owner) -----
  app.get("/jobs", async (c) => {
    const owner = require(c, "OWNER");
    return c.json({ jobs: await listJobs(db, owner.ownerId) });
  });

  /** One result: the run's answer and what it bought to produce it. */
  app.get("/jobs/:id/runs/:runId", async (c) => {
    const owner = require(c, "OWNER");
    return c.json(await runResult(db, owner.ownerId, c.req.param("id"), c.req.param("runId")));
  });

  /** What the AI operator produced for this job: each run's answer, newest first. */
  app.get("/jobs/:id/runs", async (c) => {
    const owner = require(c, "OWNER");
    return c.json({ runs: await jobRuns(db, owner.ownerId, c.req.param("id")) });
  });

  app.get("/jobs/:id/decisions", async (c) => {
    const owner = require(c, "OWNER");
    return c.json({ decisions: await jobDecisions(db, owner.ownerId, c.req.param("id")) });
  });

  app.get("/jobs/:id/payees", async (c) => {
    const owner = require(c, "OWNER");
    return c.json({ payees: await jobPayees(db, owner.ownerId, c.req.param("id")) });
  });

  app.get("/jobs/:id/agents", async (c) => {
    const owner = require(c, "OWNER");
    return c.json({ agents: await jobAgents(db, owner.ownerId, c.req.param("id")) });
  });

  /** The life of the owner's jobs (created, opened, funded, closed), for the daybook. */
  app.get("/job-events", async (c) => {
    const owner = require(c, "OWNER");
    return c.json({ events: await ownerJobEvents(db, owner.ownerId) });
  });

  app.get("/decisions", async (c) => {
    const owner = require(c, "OWNER");
    const asked = Number(c.req.query("limit") ?? 100);
    const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 200) : 100;
    return c.json({ decisions: await ownerActivity(db, owner.ownerId, limit) });
  });

  app.get("/decisions/:id", async (c) => {
    const owner = require(c, "OWNER");
    return c.json(await decisionEvidence(db, owner.ownerId, c.req.param("id")));
  });

  // ----- Owner routes -----
  app.post("/jobs", async (c) => {
    const owner = require(c, "OWNER");
    const input = await body(c, createJobBody);
    if (deps.maxJobBudget !== undefined && input.budget > deps.maxJobBudget) {
      throw new HttpError(
        422,
        "BUDGET_ABOVE_CAP",
        `A job's budget can be at most ${formatUsdc(deps.maxJobBudget)} USDC on this server`,
      );
    }
    const job = await createJob(db, owner.ownerId, input, deps.wallets);
    return c.json(jobView(job), 201);
  });

  /** The owner's own traction numbers. */
  app.get("/metrics", async (c) => {
    const owner = require(c, "OWNER");
    return c.json(await computeMetrics(db, owner.ownerId));
  });

  app.post("/approvers", async (c) => {
    const owner = require(c, "OWNER");
    const input = await body(
      c,
      z.object({ name: z.string().min(1).max(100), walletAddress: z.string() }),
    );
    const { approver, key } = await createApprover(
      db,
      owner.ownerId,
      input.name,
      input.walletAddress,
    );
    return c.json(
      {
        approver: { id: approver.id, name: approver.name, walletAddress: approver.walletAddress },
        key,
      },
      201,
    );
  });

  // ----- Approvals: owners and approvers see and decide payments waiting for a human -----
  app.get("/approvals", async (c) => {
    const who = require(c, "OWNER", "APPROVER");
    if (deps.chain === undefined) throw badRequest("Approvals aren't enabled on this server");
    return c.json({ pending: await listPending(db, who.ownerId, deps.chain) });
  });

  app.post("/approvals/:id", async (c) => {
    const who = require(c, "OWNER", "APPROVER");
    const input = await body(
      c,
      z.discriminatedUnion("verdict", [
        z.object({
          verdict: z.literal("APPROVE"),
          approverAddress: z.string(),
          signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
          deadline: z.number().int().positive(),
          policyVersion: z.number().int().positive(),
        }),
        z.object({ verdict: z.literal("REJECT"), note: z.string().max(500).optional() }),
      ]),
    );
    if (input.verdict === "REJECT") {
      const auth = await reject(db, who.ownerId, c.req.param("id"), input.note);
      return c.json({ id: auth.id, state: auth.state });
    }
    if (deps.chain === undefined) throw badRequest("Approvals aren't enabled on this server");
    const auth = await approve(db, who.ownerId, c.req.param("id"), input, deps.chain);
    return c.json({ id: auth.id, state: auth.state });
  });

  /** After investigating an unexplained payout, the owner lifts the freeze in Bursar. */
  app.post("/jobs/:id/unfreeze", async (c) => {
    const owner = require(c, "OWNER");
    const job = await getOwnedJob(db, owner.ownerId, c.req.param("id"));
    const [updated] = await db
      .update(jobs)
      .set({ frozenReason: null })
      .where(eq(jobs.id, job.id))
      .returning();
    return c.json(jobView(updated ?? job));
  });

  app.get("/jobs/:id", async (c) => {
    const owner = require(c, "OWNER");
    const job = await getOwnedJob(db, owner.ownerId, c.req.param("id"));
    return c.json({ ...jobView(job), closeTx: await closeTxOf(db, job) });
  });

  /** The job's entries in the hash-chained audit log, each with the anchor on Arc covering it. */
  app.get("/jobs/:id/audit", async (c) => {
    const owner = require(c, "OWNER");
    return c.json({ entries: await jobAuditTrail(db, owner.ownerId, c.req.param("id")) });
  });

  /** Recomputes the whole audit log and checks it against the latest head anchored on Arc. */
  app.get("/audit/status", async (c) => {
    require(c, "OWNER");
    return c.json(await auditStatus(db));
  });

  /** Sets (or clears) the operator's brief. Setting it also asks for a fresh automatic run. */
  app.post("/jobs/:id/brief", async (c) => {
    const owner = require(c, "OWNER");
    const input = await body(c, z.object({ brief: z.string().max(4000).nullable() }));
    const job = await getOwnedJob(db, owner.ownerId, c.req.param("id"));
    const brief = input.brief?.trim() || null;
    const [updated] = await db
      .update(jobs)
      .set({ brief, operatorRunAt: null })
      .where(eq(jobs.id, job.id))
      .returning();
    if (updated === undefined) throw notFound("Job");
    return c.json(jobView(updated));
  });

  app.post("/jobs/:id/payees", async (c) => {
    const owner = require(c, "OWNER");
    const input = await body(c, payeeBody);
    const payee = await addPayee(db, owner.ownerId, c.req.param("id"), input);
    return c.json(payee, 201);
  });

  app.post("/jobs/:id/category-limits", async (c) => {
    const owner = require(c, "OWNER");
    const input = await body(
      c,
      z.object({ category: z.string().min(1).max(64), limit: usdcAmount }),
    );
    const row = await setCategoryLimit(
      db,
      owner.ownerId,
      c.req.param("id"),
      input.category,
      input.limit,
    );
    return c.json({ category: row?.category, limit: formatUsdc(row?.spendLimit ?? 0n) }, 201);
  });

  app.post("/jobs/:id/agents", async (c) => {
    const owner = require(c, "OWNER");
    const { agent, key } = await createAgent(
      db,
      owner.ownerId,
      c.req.param("id"),
      await body(c, agentBody),
    );
    return c.json({ agent: agentView(agent), key }, 201);
  });

  app.post("/agents/:id/revoke", async (c) => {
    const owner = require(c, "OWNER");
    return c.json(await revokeAgent(db, owner.ownerId, c.req.param("id")));
  });

  /** Replaces an agent: the old one (and its helpers) is revoked; the new one gets what was left. */
  app.post("/agents/:id/replace", async (c) => {
    const owner = require(c, "OWNER");
    const input = await body(c, replaceBody);
    const result = await replaceAgent(
      db,
      { kind: "OWNER", ownerId: owner.ownerId },
      c.req.param("id"),
      input,
    );
    return c.json(
      { agent: agentView(result.agent), key: result.key, replaced: result.replaced },
      201,
    );
  });

  // ----- Agent routes: always scoped to the key's own job and agent -----
  app.post("/spend/request", async (c) => {
    const agent = require(c, "AGENT");
    const result = await requestSpend(db, agent, await body(c, spendBody));
    const status = result.replayed ? 200 : 201;
    return c.json(decisionView(result.decision, result.authorization, result.replayed), status);
  });

  /**
   * Waits (up to the configured limit) for a payment to finish, then answers 200 with the outcome,
   * or 202 while it's still in flight: the agent then polls /spend/authorizations/:id.
   */
  async function respondWithOutcome(c: Context, result: SpendResult) {
    let authorization = result.authorization;
    const deadline = Date.now() + (deps.payments?.waitMs ?? 0);
    while (authorization !== null && !terminal.has(authorization.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const [fresh] = await db
        .select()
        .from(authorizations)
        .where(eq(authorizations.id, authorization.id));
      authorization = fresh ?? null;
    }
    const done = authorization === null || terminal.has(authorization.state);
    return c.json(
      {
        ...decisionView(result.decision, result.authorization, result.replayed),
        // Named "purchase" for invoices too, so agents read one shape for every payment.
        purchase: authorization === null ? null : authorizationView(authorization),
      },
      done ? 200 : 202,
    );
  }

  /**
   * Pays a vendor's invoice straight from the vault to an allow-listed address. Same policy,
   * reservation, approval and audit trail as a purchase; the worker's vault release IS the
   * payment. Waits for the outcome like a purchase does.
   */
  app.post("/spend/invoice", async (c) => {
    const agent = require(c, "AGENT");
    const input = await body(c, invoiceBody);
    const result = await requestSpend(db, agent, {
      operationId: input.operationId,
      kind: "INVOICE",
      payee: { kind: "ADDRESS", value: input.payee },
      amount: input.amount,
      invoiceRef: input.invoiceRef,
      reasoning: input.reasoning,
    });
    return respondWithOutcome(c, result);
  });

  /**
   * Buys an x402 resource: quote it, decide and reserve against the job's budget, then let the
   * worker release the money, pay the seller and confirm settlement. Waits for the outcome up to
   * a limit; after that returns 202 and the agent polls /spend/authorizations/:id.
   */
  app.post("/spend/purchase", async (c) => {
    const agent = require(c, "AGENT");
    const payments = deps.payments;
    if (payments === undefined) throw badRequest("Purchases aren't enabled on this server");
    const input = await body(c, purchaseBody);

    // The allow-list is checked BEFORE any request leaves the server: Bursar never fetches a URL
    // for an agent unless the owner allow-listed its origin. A refused origin is still recorded
    // as a decision (at the agent's max price), so the evidence trail shows the attempt.
    const { origin, allowed, via } = await allowListed(agent.jobId, input.url, input.method);
    if (!allowed) {
      const denied = await requestSpend(db, agent, {
        operationId: input.operationId,
        kind: "PURCHASE",
        payee: { kind: "X402_ORIGIN", value: origin },
        amount: input.maxPrice,
        reasoning: input.reasoning,
        resourceUrl: input.url,
      });
      return c.json(decisionView(denied.decision, denied.authorization, denied.replayed), 200);
    }

    const request = requested(input);
    let quoted;
    try {
      quoted = await quote(input.url, payments, request);
    } catch (error) {
      if (error instanceof UnsafeUrlError || error instanceof QuoteError) {
        throw new HttpError(422, "QUOTE_FAILED", error.message);
      }
      throw error;
    }
    if (quoted.amount > input.maxPrice) {
      throw new HttpError(
        422,
        "PRICE_ABOVE_MAX",
        `The seller asks ${formatUsdc(quoted.amount)} USDC, above your max of ${formatUsdc(input.maxPrice)}`,
      );
    }
    // Allowed through a marketplace: never above the owner's per-call limit, or, without one, the
    // price the marketplace lists. (A listing shows a base price; a seller may charge per item,
    // like per URL fetched, so the owner's limit is the ceiling when there is one.)
    if (via !== null) {
      const ceiling = via.maxPrice ?? via.listing.price;
      if (quoted.amount > ceiling) {
        const name = MARKETPLACES[via.marketplace]?.name ?? via.marketplace;
        throw new HttpError(
          422,
          "PRICE_ABOVE_LISTING",
          via.maxPrice === undefined
            ? `The seller asks ${formatUsdc(quoted.amount)} USDC; ${name} lists it at ${formatUsdc(via.listing.price)}`
            : `The seller asks ${formatUsdc(quoted.amount)} USDC, above this job's limit of ${formatUsdc(via.maxPrice)} per marketplace call`,
        );
      }
    }

    if (quoted.rail === "GATEWAY") {
      const [job] = await db.select().from(jobs).where(eq(jobs.id, agent.jobId));
      const tooHigh =
        job === undefined
          ? null
          : gatewayAboveApproval(quoted.rail, quoted.amount, job.approvalThreshold);
      if (tooHigh !== null) throw new HttpError(422, "GATEWAY_ABOVE_APPROVAL", tooHigh);
    }

    const result = await requestSpend(db, agent, {
      operationId: input.operationId,
      kind: "PURCHASE",
      payee: { kind: "X402_ORIGIN", value: quoted.url },
      amount: quoted.amount,
      reasoning: input.reasoning,
      payment: {
        url: quoted.url,
        quote: {
          paymentRequired: quoted.paymentRequired,
          requirements: quoted.requirements,
          request: quoted.request,
        },
      },
      rail: quoted.rail,
      ...(via === null
        ? {}
        : {
            allowedBy: {
              kind: "MARKETPLACE" as const,
              value: via.marketplace,
              source: `marketplace:${via.marketplace}`,
            },
          }),
    });
    return respondWithOutcome(c, result);
  });

  /**
   * Searches the marketplaces on this job's allow-list: what the agent may buy, best match first.
   * Only listings for our network and within the owner's filters; prices are the listed ones (the
   * seller's 402 quote is checked against them at purchase).
   */
  app.get("/spend/marketplace", async (c) => {
    const agent = require(c, "AGENT");
    const network = deps.payments?.network;
    if (network === undefined) throw badRequest("Purchases aren't enabled on this server");
    const q = (c.req.query("q") ?? "").slice(0, 200);
    const limit = Number(c.req.query("limit") ?? 20);
    const rows = await db
      .select()
      .from(payees)
      .where(and(eq(payees.jobId, agent.jobId), eq(payees.kind, "MARKETPLACE")));
    if (rows.length === 0) {
      throw new HttpError(404, "NO_MARKETPLACE", "No marketplace is on this job's allow-list");
    }
    const results: ReturnType<typeof listingView>[] = [];
    const unavailable: string[] = [];
    let anyOnNetwork = false;
    for (const row of rows) {
      try {
        const listings = await listingsOf(row.value);
        anyOnNetwork ||= listings.some((l) => l.networks.includes(network));
        const found = searchListings(
          listings,
          q,
          network,
          filtersOf(row.filters),
          Number.isFinite(limit) ? limit : 20,
        );
        results.push(...found.map((l) => listingView(row.value, l)));
      } catch (error) {
        if (!(error instanceof MarketplaceError)) throw error;
        unavailable.push(row.value);
      }
    }
    // Nothing found is different from nothing sold here: say which, so nobody blames the search.
    const note =
      results.length === 0 && unavailable.length === 0 && !anyOnNetwork
        ? `The marketplace lists no services that take payment on this job's network (${network}). Services are listed for other networks only (Arc mainnet), so nothing can be bought here.`
        : undefined;
    return c.json({ results, unavailable, ...(note === undefined ? {} : { note }) });
  });

  /**
   * The sellers this job may pay: the agent's menu. Each allow-listed origin's catalog
   * (`/.well-known/x402`) is included so the agent knows real URLs instead of guessing; only
   * allow-listed origins are ever contacted, and a seller without a catalog just shows none.
   */
  app.get("/spend/payees", async (c) => {
    const agent = require(c, "AGENT");
    const rows = await db.select().from(payees).where(eq(payees.jobId, agent.jobId));
    const payments = deps.payments;
    const listed = await Promise.all(
      rows.map(async (p) => {
        let catalog: CatalogEntry[] | null = null;
        let catalogError: string | null = null;
        if (p.kind === "X402_ORIGIN" && payments !== undefined) {
          try {
            catalog = await discover(p.value, payments);
          } catch (error) {
            if (!(error instanceof UnsafeUrlError || error instanceof QuoteError)) throw error;
            catalogError = error.message;
          }
        }
        const source = p.kind === "MARKETPLACE" ? MARKETPLACES[p.value] : undefined;
        return {
          kind: p.kind,
          value: p.value,
          label: p.label,
          category: p.category,
          catalog,
          catalogError,
          // A marketplace: search it with GET /spend/marketplace?q=... to find what to buy.
          ...(source === undefined
            ? {}
            : {
                marketplace: {
                  name: source.name,
                  homepage: source.homepage,
                  filters: marketplaceFilters(p.filters),
                },
              }),
        };
      }),
    );
    return c.json({ payees: listed });
  });

  /** Asks an allow-listed seller its price without buying: no decision, no reservation. */
  app.post("/spend/quote", async (c) => {
    const agent = require(c, "AGENT");
    const payments = deps.payments;
    if (payments === undefined) throw badRequest("Purchases aren't enabled on this server");
    const input = await body(c, z.object({ url: z.string().url().max(2000), ...requestShape }));
    const { allowed } = await allowListed(agent.jobId, input.url, input.method);
    if (!allowed) {
      throw new HttpError(403, "PAYEE_NOT_ALLOWED", "That seller isn't on this job's allow-list");
    }
    try {
      const q = await quote(input.url, payments, requested(input));
      return c.json({
        url: q.url,
        price: formatUsdc(q.amount),
        payTo: q.payTo,
        description: q.paymentRequired.resource?.description ?? null,
      });
    } catch (error) {
      if (error instanceof UnsafeUrlError || error instanceof QuoteError) {
        throw new HttpError(422, "QUOTE_FAILED", error.message);
      }
      throw error;
    }
  });

  /** The operator reports each run: its model spend is charged to the job's profit. */
  app.post("/spend/runs", async (c) => {
    const agent = require(c, "AGENT");
    const input = await body(c, runBody);
    const [run] = await db
      .insert(operatorRuns)
      .values({
        ...input,
        summary: input.summary ?? null,
        costMicros: BigInt(input.costMicros),
        jobId: agent.jobId,
        agentId: agent.agentId,
      })
      .returning();
    await db
      .update(jobs)
      .set({ llmCostMicros: sql`${jobs.llmCostMicros} + ${input.costMicros.toString()}::bigint` })
      .where(eq(jobs.id, agent.jobId));
    return c.json({ id: run?.id }, 201);
  });

  app.get("/spend/authorizations/:id", async (c) => {
    const agent = require(c, "AGENT");
    const [auth] = await db
      .select()
      .from(authorizations)
      .where(and(eq(authorizations.id, c.req.param("id")), eq(authorizations.jobId, agent.jobId)));
    if (auth === undefined) throw notFound("Authorization");
    return c.json(authorizationView(auth));
  });

  app.post("/spend/subagent", async (c) => {
    const agent = require(c, "AGENT");
    const { agent: child, key } = await spawnSubagent(db, agent, await body(c, agentBody));
    return c.json({ agent: agentView(child), key }, 201);
  });

  /** An agent replaces one of its own helpers (stuck or misbehaving) with a fresh one. */
  app.post("/spend/subagents/:id/replace", async (c) => {
    const agent = require(c, "AGENT");
    const input = await body(c, replaceBody);
    const result = await replaceAgent(db, { kind: "PARENT", agent }, c.req.param("id"), input);
    return c.json(
      { agent: agentView(result.agent), key: result.key, replaced: result.replaced },
      201,
    );
  });

  app.get("/spend/budget", async (c) => {
    const agent = require(c, "AGENT");
    const [job] = await db.select().from(jobs).where(eq(jobs.id, agent.jobId));
    if (job === undefined) throw notFound("Job");
    return c.json({
      jobId: job.id,
      status: job.status,
      remaining: formatUsdc(job.budget - committedOf(job)),
      spent: formatUsdc(job.settled),
      revenueReceived: formatUsdc(job.revenueReceived),
      perTxCap: formatUsdc(job.perTxCap),
      approvalThreshold: formatUsdc(job.approvalThreshold),
      expiresAt: job.expiresAt.toISOString(),
    });
  });

  app.notFound((c) =>
    c.json({ error: "NOT_FOUND", message: `No route for ${c.req.method} ${c.req.path}` }, 404),
  );

  app.onError((error, c) => {
    if (error instanceof RateLimitedError) {
      c.header("Retry-After", String(error.verdict.retryAfter));
      c.header("RateLimit-Limit", String(error.verdict.limit));
      c.header("RateLimit-Remaining", "0");
      return c.json(error.toBody(), 429);
    }
    if (error instanceof HttpError) return c.json(error.toBody(), error.status);
    if (error instanceof LedgerError) {
      return c.json(
        { error: error.code, message: error.message },
        error.code === "NOT_FOUND" ? 404 : 409,
      );
    }
    process.stderr.write(`${error.stack ?? error.message}\n`);
    return c.json({ error: "INTERNAL", message: "Internal server error" }, 500);
  });

  return app;
}
