import { parseUsdc } from "@bursar/money";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach } from "vitest";
import { createApp } from "../src/app.js";
import type { AgentPrincipal } from "../src/auth/principal.js";
import { createDb, type Db } from "@bursar/db";
import { createAgent } from "../src/services/agents.js";
import {
  addPayee,
  createJob,
  recordFunding,
  recordJobCreatedOnChain,
} from "../src/services/jobs.js";
import { createOwner } from "../src/services/owners.js";
import { testDatabaseUrl } from "./global-setup.js";

/** A real Postgres connection pool. Big enough for the concurrency tests. */
const created = createDb(testDatabaseUrl(), { max: 30 });
export const db: Db = created.db;
export const client = created.client;
export const app = createApp(db);

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE owners, jobs, agents, credentials, payees, category_limits, decisions, authorizations, chain_events, chain_cursors, approvers, approvals, operator_runs, metrics_daily, audit_chain, audit_anchors, siwe_nonces, alert_targets, alerts, telegram_links RESTART IDENTITY CASCADE`,
  );
});

afterAll(async () => {
  await client.end();
});

export const SELLER = "https://seller.example.com";

export interface SeedOptions {
  readonly budget?: string;
  readonly perTxCap?: string;
  readonly approvalThreshold?: string;
  readonly windowCap?: string;
  readonly agents?: number;
}

/** An owner with one ACTIVE, fully funded job, one allow-listed x402 seller, and N agents. */
export async function seedJob(options: SeedOptions = {}) {
  const budget = parseUsdc(options.budget ?? "1.00");
  const { owner, key: ownerKey } = await createOwner(db, "Test Studio");
  const job = await createJob(db, owner.id, {
    title: "Explainer film",
    customer: "Test customer",
    budget,
    perTxCap: parseUsdc(options.perTxCap ?? options.budget ?? "1.00"),
    approvalThreshold: parseUsdc(options.approvalThreshold ?? options.budget ?? "1.00"),
    windowCap: parseUsdc(options.windowCap ?? options.budget ?? "1.00"),
    windowSeconds: 3600,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    delegationAllowed: true,
  });
  await recordJobCreatedOnChain(db, job.id, `vault-${job.id}`);
  await recordFunding(db, job.id, budget);
  await addPayee(db, owner.id, job.id, { kind: "X402_ORIGIN", value: SELLER, category: "data" });

  const created = [];
  for (let i = 0; i < (options.agents ?? 1); i += 1) {
    const { agent, key } = await createAgent(db, owner.id, job.id, {
      name: `Agent ${i + 1}`,
      role: "worker",
    });
    const principal: AgentPrincipal = {
      role: "AGENT",
      credentialId: "test",
      ownerId: owner.id,
      jobId: job.id,
      agentId: agent.id,
    };
    created.push({ agent, key, principal });
  }
  return { owner, ownerKey, job, agents: created };
}

export function spend(amount: string, operationId: string, reasoning = "test purchase") {
  return {
    operationId,
    kind: "PURCHASE" as const,
    payee: { kind: "X402_ORIGIN" as const, value: SELLER },
    amount: parseUsdc(amount),
    reasoning,
  };
}

export async function call(
  method: string,
  path: string,
  key: string | null,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers.authorization = `Bearer ${key}`;
  const init: RequestInit = { method, headers };
  if (payload !== undefined) init.body = JSON.stringify(payload);
  const response = await app.request(path, init);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
