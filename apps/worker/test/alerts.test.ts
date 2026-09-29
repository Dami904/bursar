import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  alertTargets,
  alerts,
  authorizations,
  createDb,
  jobs,
  telegramLinks,
  type Db,
} from "@bursar/db";
import { parseUsdc } from "@bursar/money";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentPrincipal } from "../../api/src/auth/principal.js";
import { createAgent } from "../../api/src/services/agents.js";
import {
  addPayee,
  createJob,
  recordFunding,
  recordJobCreatedOnChain,
} from "../../api/src/services/jobs.js";
import { createOwner } from "../../api/src/services/owners.js";
import { requestSpend } from "../../api/src/services/spend.js";
import { testDatabaseUrl } from "../../api/test/global-setup.js";
import {
  deliverAlerts,
  pollTelegram,
  produceAlerts,
  signWebhook,
  type AlertDeps,
} from "../src/alerts.js";

let db: Db;
let end: () => Promise<void>;
let server: Server;
let hookUrl = "";
const received: { headers: IncomingMessage["headers"]; body: string }[] = [];
let answer = 200;

beforeAll(async () => {
  const created = createDb(testDatabaseUrl(), { max: 5 });
  db = created.db;
  end = () => created.client.end();
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(answer);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});

afterAll(async () => {
  server.close();
  await end();
});

beforeEach(async () => {
  received.length = 0;
  answer = 200;
  await db.execute(
    sql`TRUNCATE owners, jobs, agents, credentials, payees, category_limits, decisions, authorizations, chain_events, chain_cursors, approvers, approvals, operator_runs, metrics_daily, audit_chain, audit_anchors, siwe_nonces, alert_targets, alerts, telegram_links RESTART IDENTITY CASCADE`,
  );
});

const deps = (overrides: Partial<AlertDeps> = {}): AlertDeps => ({
  db,
  webUrl: "http://console.test",
  allowPrivateWebhooks: true,
  ...overrides,
});

async function liveJob(threshold = "0.05") {
  const { owner } = await createOwner(db, "Studio");
  const job = await createJob(db, owner.id, {
    title: "Explainer film",
    customer: "Acme",
    budget: parseUsdc("1.00"),
    perTxCap: parseUsdc("1.00"),
    approvalThreshold: parseUsdc(threshold),
    windowCap: parseUsdc("1.00"),
    windowSeconds: 3600,
    expiresAt: new Date(Date.now() + 86_400_000),
    delegationAllowed: true,
  });
  await recordJobCreatedOnChain(db, job.id, `vault-${job.id}`);
  await recordFunding(db, job.id, parseUsdc("1.00"));
  await addPayee(db, owner.id, job.id, { kind: "X402_ORIGIN", value: "https://seller.example" });
  const { agent } = await createAgent(db, owner.id, job.id, { name: "Operator", role: "operator" });
  const principal: AgentPrincipal = {
    role: "AGENT",
    credentialId: "t",
    ownerId: owner.id,
    jobId: job.id,
    agentId: agent.id,
  };
  return { owner, job, principal };
}

const spend = (amount: string, operationId: string, payee = "https://seller.example") => ({
  operationId,
  kind: "PURCHASE" as const,
  payee: { kind: "X402_ORIGIN" as const, value: payee },
  amount: parseUsdc(amount),
  reasoning: "needed for scene 2",
});

describe("producing alerts", () => {
  it("queues a payment that needs approval exactly once", async () => {
    const { principal } = await liveJob();
    await requestSpend(db, principal, spend("0.20", "op-alert-001"));
    expect(await produceAlerts(deps())).toBe(1);
    expect(await produceAlerts(deps())).toBe(0);
    const [row] = await db.select().from(alerts);
    expect(row).toMatchObject({
      type: "needs_approval",
      title: "0.20 USDC needs your approval",
      link: "http://console.test/app/approvals",
    });
  });

  it("alerts at 80% of the budget, a stuck payment, a frozen job, and a burst of denials", async () => {
    const { job, principal } = await liveJob("1.00");
    const big = await requestSpend(db, principal, spend("0.85", "op-alert-101"));
    await db
      .update(authorizations)
      .set({ state: "UNRESOLVED", updatedAt: new Date(Date.now() - 6 * 60_000) })
      .where(eq(authorizations.id, big.authorization!.id));
    await db
      .update(jobs)
      .set({ reserved: 0n, unresolved: parseUsdc("0.85") })
      .where(eq(jobs.id, job.id));
    await db
      .update(jobs)
      .set({ frozenReason: "The vault paid 5 USDC with no matching payment" })
      .where(eq(jobs.id, job.id));
    for (let i = 0; i < 3; i += 1) {
      await requestSpend(
        db,
        principal,
        spend("0.01", `op-alert-2${i}0`, "https://not-allowed.example"),
      );
    }
    await produceAlerts(deps());
    const types = (await db.select({ type: alerts.type }).from(alerts)).map((a) => a.type).sort();
    expect(types).toEqual(["budget_80", "denial_burst", "job_frozen", "stuck_payment"]);
  });
});

describe("delivering alerts", () => {
  it("POSTs a signed webhook the receiver can verify", async () => {
    const { owner, principal } = await liveJob();
    await db
      .insert(alertTargets)
      .values({ ownerId: owner.id, kind: "WEBHOOK", url: hookUrl, secret: "whsec_test" });
    await requestSpend(db, principal, spend("0.20", "op-alert-301"));
    await produceAlerts(deps());
    await deliverAlerts(deps());

    expect(received).toHaveLength(1);
    const hit = received[0]!;
    const timestamp = String(hit.headers["x-bursar-timestamp"]);
    expect(hit.headers["x-bursar-signature"]).toBe(signWebhook("whsec_test", timestamp, hit.body));
    expect(JSON.parse(hit.body)).toMatchObject({ type: "needs_approval" });
    const [row] = await db.select().from(alerts);
    expect(row?.sentAt).not.toBeNull();
  });

  it("retries a failing receiver with backoff, then succeeds", async () => {
    const { owner, principal } = await liveJob();
    await db
      .insert(alertTargets)
      .values({ ownerId: owner.id, kind: "WEBHOOK", url: hookUrl, secret: "s" });
    await requestSpend(db, principal, spend("0.20", "op-alert-401"));
    await produceAlerts(deps());
    answer = 500;
    await deliverAlerts(deps());
    let [row] = await db.select().from(alerts);
    expect(row).toMatchObject({ attempts: 1, sentAt: null });
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    answer = 200;
    await deliverAlerts(deps({ now: () => new Date(Date.now() + 2 * 60_000) }));
    [row] = await db.select().from(alerts);
    expect(row?.sentAt).not.toBeNull();
  });

  it("refuses webhooks to private addresses in production", async () => {
    const { owner, principal } = await liveJob();
    await db
      .insert(alertTargets)
      .values({ ownerId: owner.id, kind: "WEBHOOK", url: hookUrl, secret: "s" });
    await requestSpend(db, principal, spend("0.20", "op-alert-501"));
    await produceAlerts(deps());
    await deliverAlerts(deps({ allowPrivateWebhooks: false }));
    expect(received).toHaveLength(0);
    const [row] = await db.select().from(alerts);
    expect(row?.lastError).toMatch(/non-public/);
  });
});

describe("Telegram", () => {
  /** A stand-in for the Telegram Bot API. */
  function fakeTelegram(updates: unknown[]) {
    const sent: Record<string, unknown>[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (method === "sendMessage") sent.push(payload);
      const result = method === "getUpdates" ? updates : { message_id: 1 };
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }) as typeof fetch;
    return { sent, fetchFn };
  }

  it("links a chat from /start <code> once, then sends alerts there", async () => {
    const { owner, principal } = await liveJob();
    await db.insert(telegramLinks).values({ code: "linkcode123", ownerId: owner.id });
    const tg = fakeTelegram([
      { update_id: 7, message: { chat: { id: 4242 }, text: "/start linkcode123" } },
    ]);
    const d = deps({ telegramToken: "test-token", fetch: tg.fetchFn });

    expect(await pollTelegram(d)).toBe(1);
    expect(await db.select().from(alertTargets)).toMatchObject([
      { kind: "TELEGRAM", chatId: "4242" },
    ]);
    expect(tg.sent[0]).toMatchObject({ chat_id: 4242, text: expect.stringContaining("Linked") });

    await requestSpend(db, principal, spend("0.20", "op-alert-601"));
    await produceAlerts(d);
    await deliverAlerts(d);
    expect(tg.sent.at(-1)).toMatchObject({
      chat_id: "4242",
      text: expect.stringContaining("needs your approval"),
    });
  });

  it("keeps one chat per account: a newer link replaces the old chat", async () => {
    const { owner } = await liveJob();
    await db.insert(alertTargets).values({ ownerId: owner.id, kind: "TELEGRAM", chatId: "111" });
    await db.insert(telegramLinks).values({ code: "newchatcode1", ownerId: owner.id });
    const tg = fakeTelegram([
      { update_id: 11, message: { chat: { id: 222 }, text: "/start newchatcode1" } },
    ]);
    await pollTelegram(deps({ telegramToken: "t", fetch: tg.fetchFn }));
    const targets = await db.select().from(alertTargets);
    expect(targets).toMatchObject([{ kind: "TELEGRAM", chatId: "222" }]);
  });

  it("won't reuse a link code", async () => {
    const { owner } = await liveJob();
    await db
      .insert(telegramLinks)
      .values({ code: "usedcode123", ownerId: owner.id, usedAt: new Date() });
    const tg = fakeTelegram([
      { update_id: 9, message: { chat: { id: 1 }, text: "/start usedcode123" } },
    ]);
    expect(await pollTelegram(deps({ telegramToken: "t", fetch: tg.fetchFn }))).toBe(0);
    expect(tg.sent[0]).toMatchObject({ text: expect.stringContaining("expired") });
  });
});
