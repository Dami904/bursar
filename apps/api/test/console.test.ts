import {
  agents as agentsTable,
  authorizations,
  chainEvents,
  credentials,
  jobs,
  operatorRuns,
} from "@bursar/db";
import { eq } from "drizzle-orm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ownersBrief } from "../src/services/console.js";
import { requestSpend } from "../src/services/spend.js";
import { db, seedJob, spend } from "./support.js";

const ORIGIN = "http://localhost:5173";
const api = createApp(db, {
  webOrigins: [ORIGIN],
  siwe: { domains: ["localhost:5173"], chainId: 5042002 },
  streamPollMs: 20,
});

async function call(method: string, path: string, key: string | null, payload?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers.authorization = `Bearer ${key}`;
  const response = await api.request(path, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function signedMessage(
  account = privateKeyToAccount(generatePrivateKey()),
  overrides: { domain?: string; chainId?: number; nonce?: string } = {},
) {
  const nonce = overrides.nonce ?? ((await call("POST", "/auth/nonce", null)).body.nonce as string);
  const message = createSiweMessage({
    address: account.address,
    chainId: overrides.chainId ?? 5042002,
    domain: overrides.domain ?? "localhost:5173",
    nonce,
    uri: ORIGIN,
    version: "1",
    statement: "Sign in to Bursar",
    issuedAt: new Date(),
  });
  return { account, nonce, message, signature: await account.signMessage({ message }) };
}

describe("wallet sign-in", () => {
  it("a new wallet signs up as an owner, can approve its own payments, and gets a session", async () => {
    const { account, message, signature } = await signedMessage();
    const response = await call("POST", "/auth/verify", null, { message, signature });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ role: "OWNER", wallet: account.address });
    const key = response.body.key as string;

    const me = await call("GET", "/me", key);
    expect(me.body).toMatchObject({ role: "OWNER", wallet: account.address.toLowerCase() });

    // Signing in again finds the same owner.
    const again = await signedMessage(account);
    const second = await call("POST", "/auth/verify", null, again);
    expect(second.body.ownerId).toBe(response.body.ownerId);
  });

  it("a nonce works once", async () => {
    const signed = await signedMessage();
    expect((await call("POST", "/auth/verify", null, signed)).status).toBe(200);
    expect((await call("POST", "/auth/verify", null, signed)).status).toBe(401);
  });

  it("refuses another site's message, another network, a made-up nonce, or someone else's signature", async () => {
    const wrongSite = await signedMessage(undefined, { domain: "evil.example" });
    expect((await call("POST", "/auth/verify", null, wrongSite)).status).toBe(401);
    const wrongChain = await signedMessage(undefined, { chainId: 1 });
    expect((await call("POST", "/auth/verify", null, wrongChain)).status).toBe(401);
    const madeUp = await signedMessage(undefined, { nonce: "a".repeat(32) });
    expect((await call("POST", "/auth/verify", null, madeUp)).status).toBe(401);
    const real = await signedMessage();
    const other = await privateKeyToAccount(generatePrivateKey()).signMessage({
      message: real.message,
    });
    expect(
      (await call("POST", "/auth/verify", null, { message: real.message, signature: other }))
        .status,
    ).toBe(401);
  });

  it("an approver's wallet signs in as that approver", async () => {
    const { ownerKey } = await seedJob();
    const approver = privateKeyToAccount(generatePrivateKey());
    await call("POST", "/approvers", ownerKey, {
      name: "Finance",
      walletAddress: approver.address,
    });
    const response = await call("POST", "/auth/verify", null, await signedMessage(approver));
    expect(response.body.role).toBe("APPROVER");
    expect((await call("GET", "/approvals", response.body.key as string)).status).not.toBe(401);
  });

  it("sessions expire, and signing out ends them at once", async () => {
    const signed = await signedMessage();
    const key = (await call("POST", "/auth/verify", null, signed)).body.key as string;
    expect((await call("POST", "/auth/logout", key)).status).toBe(200);
    expect((await call("GET", "/me", key)).status).toBe(401);

    const again = await signedMessage(signed.account);
    const second = await call("POST", "/auth/verify", null, again);
    await db
      .update(credentials)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(credentials.ownerId, second.body.ownerId as string));
    expect((await call("GET", "/me", second.body.key as string)).status).toBe(401);
  });
});

describe("console reads", () => {
  it("lists jobs with what needs the owner, and each decision with its payment state", async () => {
    const { agents, job, ownerKey } = await seedJob({ approvalThreshold: "0.05" });
    await requestSpend(db, agents[0]!.principal, spend("0.02", "op-cons-0001", "scene 2 line"));
    await requestSpend(db, agents[0]!.principal, spend("0.10", "op-cons-0002", "big one"));

    const list = await call("GET", "/jobs", ownerKey);
    expect(list.body.jobs).toMatchObject([{ id: job.id, needsYou: 1, agents: 1 }]);

    const feed = await call("GET", `/jobs/${job.id}/decisions`, ownerKey);
    expect(feed.body.decisions).toMatchObject([
      {
        amount: "0.10",
        state: "PENDING_APPROVAL",
        reasoning: "big one",
        agent: { name: "Agent 1" },
      },
      { amount: "0.02", state: "RESERVED", result: "ALLOWED" },
    ]);

    const agentsList = await call("GET", `/jobs/${job.id}/agents`, ownerKey);
    expect(agentsList.body.agents).toMatchObject([{ name: "Agent 1", committed: "0.12" }]);
  });

  it("shows one decision's evidence: checks, payment and audit entries", async () => {
    const { agents, ownerKey } = await seedJob();
    const { decision } = await requestSpend(
      db,
      agents[0]!.principal,
      spend("0.02", "op-cons-0101"),
    );
    const evidence = await call("GET", `/decisions/${decision.id}`, ownerKey);
    expect(evidence.status).toBe(200);
    expect(evidence.body).toMatchObject({
      decision: { id: decision.id, amount: "0.02", result: "ALLOWED" },
      payment: { state: "RESERVED" },
      audit: [{ seq: 1, event: "decision" }],
      anchor: null,
    });
    expect((evidence.body.decision as { checks: unknown[] }).checks).toHaveLength(12);
  });

  it("lists the owner's decisions across every job, each naming its job, and only theirs", async () => {
    const a = await seedJob({ approvalThreshold: "0.05" });
    const other = await seedJob();
    await requestSpend(db, a.agents[0]!.principal, spend("0.02", "op-cons-0301", "one"));
    await requestSpend(db, a.agents[0]!.principal, spend("0.10", "op-cons-0302", "two"));
    await requestSpend(db, other.agents[0]!.principal, spend("0.03", "op-cons-0303", "not mine"));

    const feed = await call("GET", "/decisions?limit=50", a.ownerKey);
    expect(feed.status).toBe(200);
    const rows = feed.body.decisions as { amount: string; job: { id: string } }[];
    expect(rows.map((r) => r.amount)).toEqual(["0.10", "0.02"]); // newest first, none of the other owner's
    expect(rows.every((r) => r.job.id === a.job.id)).toBe(true);
    expect(feed.body.decisions).toMatchObject([
      { state: "PENDING_APPROVAL", job: { title: expect.any(String) } },
      { state: "RESERVED" },
    ]);
    expect((await call("GET", "/decisions", null)).status).toBe(401);
  });

  it("keeps each owner to their own jobs and decisions", async () => {
    const a = await seedJob();
    const b = await seedJob();
    const { decision } = await requestSpend(
      db,
      a.agents[0]!.principal,
      spend("0.02", "op-cons-0201"),
    );
    expect((await call("GET", `/jobs/${a.job.id}/decisions`, b.ownerKey)).status).toBe(404);
    expect((await call("GET", `/decisions/${decision.id}`, b.ownerKey)).status).toBe(404);
    expect((await call("GET", "/jobs", b.ownerKey)).body.jobs).toHaveLength(1);
  });
});

describe("live stream", () => {
  it("says 'change' straight away and again when something happens", async () => {
    const { agents, ownerKey } = await seedJob();
    const controller = new AbortController();
    const response = await api.request("/stream", {
      headers: { authorization: `Bearer ${ownerKey}` },
      signal: controller.signal,
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (count: number) => {
      while ((text.match(/event: change/g) ?? []).length < count) {
        const { value } = await reader.read();
        text += decoder.decode(value);
      }
    };
    await readUntil(1);
    await requestSpend(db, agents[0]!.principal, spend("0.02", "op-cons-0301"));
    await readUntil(2);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    expect((text.match(/event: change/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("CORS", () => {
  it("lets the console's origin call the API, and nobody else", async () => {
    const preflight = (origin: string) =>
      api.request("/jobs", {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      });
    expect((await preflight(ORIGIN)).headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(
      (await preflight("https://evil.example")).headers.get("access-control-allow-origin"),
    ).toBeNull();
  });
});

describe("operator brief", () => {
  it("sets a brief, which asks for a fresh automatic run, and can clear it", async () => {
    const { job, ownerKey } = await seedJob();
    await db.update(jobs).set({ operatorRunAt: new Date() }).where(eq(jobs.id, job.id));
    const set = await call("POST", `/jobs/${job.id}/brief`, ownerKey, {
      brief: "  Buy one line.  ",
    });
    expect(set.body).toMatchObject({ brief: "Buy one line.", operatorRunAt: null });
    const cleared = await call("POST", `/jobs/${job.id}/brief`, ownerKey, { brief: null });
    expect(cleared.body).toMatchObject({ brief: null });
    const other = await seedJob();
    expect(
      (await call("POST", `/jobs/${job.id}/brief`, other.ownerKey, { brief: "x" })).status,
    ).toBe(404);
  });
});

describe("public demo", () => {
  it("shows the demo job to anyone, and nothing else", async () => {
    const demo = await seedJob();
    const other = await seedJob();
    const { decision } = await requestSpend(
      db,
      demo.agents[0]!.principal,
      spend("0.02", "op-demo-0001"),
    );
    const { decision: private_ } = await requestSpend(
      db,
      other.agents[0]!.principal,
      spend("0.02", "op-demo-0002"),
    );
    const app = createApp(db, { demoJobId: demo.job.id });
    const get = async (path: string) => {
      const response = await app.request(path);
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    const page = await get("/demo");
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ job: { id: demo.job.id }, decisions: [{ id: decision.id }] });
    expect((await get(`/demo/decisions/${decision.id}`)).status).toBe(200);
    // Another job's decision is not public, even by id.
    expect((await get(`/demo/decisions/${private_.id}`)).status).toBe(404);
    // Without a demo job configured, there's nothing public.
    expect((await createApp(db).request("/demo")).status).toBe(404);
  });
});

describe("results", () => {
  it("shows the owner each operator run's answer, newest first, and nobody else", async () => {
    const { agents, job, ownerKey } = await seedJob();
    const report = (summary: string) =>
      call("POST", "/spend/runs", agents[0]!.key, {
        model: "gemini-test",
        brief: "Summarise celomind.vercel.app",
        steps: 4,
        inputTokens: 1000,
        outputTokens: 200,
        costMicros: 3137,
        outcome: "completed",
        summary,
      });
    expect((await report("First answer")).status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await report("CeloMind is an AI assistant for the Celo network.");

    const runs = await call("GET", `/jobs/${job.id}/runs`, ownerKey);
    expect(runs.status).toBe(200);
    expect(runs.body.runs).toEqual([
      expect.objectContaining({
        summary: "CeloMind is an AI assistant for the Celo network.",
        brief: "Summarise celomind.vercel.app",
        outcome: "completed",
        aiCost: "0.0031",
      }),
      expect.objectContaining({ summary: "First answer" }),
    ]);

    const other = await seedJob();
    expect((await call("GET", `/jobs/${job.id}/runs`, other.ownerKey)).status).toBe(404);
    expect((await call("GET", `/jobs/${job.id}/runs`, agents[0]!.key)).status).toBe(403);
  });
});

describe("a helper's run", () => {
  it("isn't listed on its own, and doesn't cut off the purchases its operator made before it", async () => {
    const { agents, job, ownerKey } = await seedJob();
    const agent = agents[0]!;
    const run = (agentId: string, summary: string, brief: string) =>
      db.insert(operatorRuns).values({
        jobId: job.id,
        agentId,
        model: "test",
        brief,
        steps: 3,
        inputTokens: 1,
        outputTokens: 1,
        costMicros: 1n,
        outcome: "completed",
        summary,
      });
    const mine = await requestSpend(db, agent.principal, spend("0.10", "op-helper-0001"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [helper] = await db
      .insert(agentsTable)
      .values({
        jobId: job.id,
        name: "helper: buyer",
        role: "operator",
        parentAgentId: agent.agent.id,
      })
      .returning();
    await run(helper!.id, "helper done", "Buy the thing");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await run(agent.agent.id, "operator done", "Delegate it");

    const listed = (await call("GET", `/jobs/${job.id}/runs`, ownerKey)).body.runs as {
      id: string;
      summary: string;
    }[];
    expect(listed.map((r) => r.summary)).toEqual(["operator done"]);
    const result = await call("GET", `/jobs/${job.id}/runs/${listed[0]!.id}`, ownerKey);
    expect((result.body.purchases as { id: string }[]).map((d) => d.id)).toEqual([
      mine.decision.id,
    ]);
  });
});

describe("the transaction that closed a job", () => {
  it("is on the job once it is closed, and not before", async () => {
    const { job, ownerKey } = await seedJob();
    const vaultJobId = `0x${job.id.replaceAll("-", "").padEnd(64, "0")}`;
    await db.update(jobs).set({ vaultJobId }).where(eq(jobs.id, job.id));
    const open = await call("GET", `/jobs/${job.id}`, ownerKey);
    expect(open.body.closeTx).toBeNull();

    await db.insert(chainEvents).values({
      txHash: "0xclosed",
      logIndex: 1,
      blockNumber: 10,
      eventName: "Withdrawn",
      vaultJobId,
    });
    // Still open: a withdrawal alone doesn't make it closed.
    expect((await call("GET", `/jobs/${job.id}`, ownerKey)).body.closeTx).toBeNull();
    await db.update(jobs).set({ status: "CLOSED" }).where(eq(jobs.id, job.id));
    expect((await call("GET", `/jobs/${job.id}`, ownerKey)).body.closeTx).toBe("0xclosed");
  });
});

describe("when stuck payments clear", () => {
  it("is the latest signature expiry plus the grace, and null when nothing is stuck", async () => {
    const { agents, job, ownerKey } = await seedJob();
    expect((await call("GET", `/jobs/${job.id}`, ownerKey)).body.stuckUntil).toBeNull();

    const first = await requestSpend(db, agents[0]!.principal, spend("0.10", "op-stuck-0001"));
    const second = await requestSpend(db, agents[0]!.principal, spend("0.10", "op-stuck-0002"));
    const soon = new Date(Date.now() + 3_600_000);
    const later = new Date(Date.now() + 4 * 86_400_000);
    for (const [decision, validBefore] of [
      [first, soon],
      [second, later],
    ] as const) {
      await db
        .update(authorizations)
        .set({ state: "UNRESOLVED", validBefore })
        .where(eq(authorizations.id, decision.authorization!.id));
    }
    const { body } = await call("GET", `/jobs/${job.id}`, ownerKey);
    expect(new Date(body.stuckUntil as string).getTime()).toBe(later.getTime() + 15_000);
  });
});

describe("the jobs' own moments", () => {
  it("lists created, opened, funded and closed, with their transactions, for the owner only", async () => {
    const { job, ownerKey } = await seedJob();
    const vaultJobId = `0x${job.id.replaceAll("-", "").padEnd(64, "0")}`;
    await db.update(jobs).set({ vaultJobId, status: "CLOSED" }).where(eq(jobs.id, job.id));
    await db.insert(chainEvents).values([
      { txHash: "0xopen", logIndex: 0, blockNumber: 1, eventName: "JobCreated", vaultJobId },
      { txHash: "0xfund", logIndex: 1, blockNumber: 2, eventName: "Funded", vaultJobId },
      { txHash: "0xshut", logIndex: 2, blockNumber: 3, eventName: "Withdrawn", vaultJobId },
      { txHash: "0xother", logIndex: 3, blockNumber: 3, eventName: "Released", vaultJobId },
    ]);
    const { body } = await call("GET", "/job-events", ownerKey);
    const events = body.events as { kind: string; txHash: string | null }[];
    expect(events.map((e) => e.kind).sort()).toEqual(["closed", "created", "funded", "opened"]);
    expect(events.find((e) => e.kind === "closed")?.txHash).toBe("0xshut");
    expect(events.find((e) => e.kind === "created")?.txHash).toBeNull();
    // Another owner sees none of it.
    const other = await seedJob();
    const theirs = (await call("GET", "/job-events", other.ownerKey)).body.events as unknown[];
    expect(theirs).toHaveLength(1);
  });
});

describe("a result page", () => {
  it("shows one run's answer with only the purchases made for it, and what they cost", async () => {
    const { agents, job, ownerKey } = await seedJob();
    const agent = agents[0]!;
    const report = (summary: string) =>
      call("POST", "/spend/runs", agent.key, {
        model: "gemini-test",
        brief: "Research",
        steps: 3,
        inputTokens: 10,
        outputTokens: 10,
        costMicros: 1000,
        outcome: "completed",
        summary,
      });
    const before = await requestSpend(db, agent.principal, spend("0.10", "op-result-0001"));
    await report("**First** answer");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const mine = await requestSpend(db, agent.principal, spend("0.20", "op-result-0002"));
    await db
      .update(authorizations)
      .set({ state: "SETTLED" })
      .where(eq(authorizations.id, mine.authorization!.id));
    await report("Second answer");

    const runs = (await call("GET", `/jobs/${job.id}/runs`, ownerKey)).body.runs as {
      id: string;
    }[];
    const result = await call("GET", `/jobs/${job.id}/runs/${runs[0]!.id}`, ownerKey);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ run: { summary: "Second answer" }, paid: "0.20" });
    expect((result.body.purchases as { id: string }[]).map((d) => d.id)).toEqual([
      mine.decision.id,
    ]);
    expect(
      (result.body.purchases as { id: string }[]).some((d) => d.id === before.decision.id),
    ).toBe(false);

    const other = await seedJob();
    expect((await call("GET", `/jobs/${job.id}/runs/${runs[0]!.id}`, other.ownerKey)).status).toBe(
      404,
    );
    const demo = createApp(db, { demoJobId: job.id });
    const pub = await demo.request(`/demo/runs/${runs[1]!.id}`);
    expect(pub.status).toBe(200);
    expect(await pub.json()).toMatchObject({ run: { summary: "**First** answer" } });
  });
});

describe("a run's brief", () => {
  it("shows what the owner wrote, not the notes Bursar added for the operator", () => {
    const written = "Generate an image of a red door.";
    const stored = `${written}

New revenue: a customer just paid 1 USDC into this job.

What earlier runs on this job already did (don't repeat a purchase unless the brief asks for more):
- a purchase`;
    expect(ownersBrief(stored)).toBe(written);
    expect(
      ownersBrief(`${written}

What earlier runs on this job already did (x):
- y`),
    ).toBe(written);
    expect(ownersBrief(written)).toBe(written);
  });
});
