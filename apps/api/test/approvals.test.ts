import { approvals, authorizations, jobs } from "@bursar/db";
import { parseUsdc } from "@bursar/money";
import { approvalTypedData, vaultJobIdFor, vaultOpIdFor } from "@bursar/payments";
import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { requestSpend } from "../src/services/spend.js";
import { db, seedJob, spend } from "./support.js";

const CHAIN = { chainId: 5042002, vault: "0x5Cd51a31fE931D31574Eadd083A0B5c210CA2cB6" as Hex };
const JOB_WALLET = "0x41048de7f28c92ac2bef61fbc35d7c95e2114b96" as Hex;
const approverAccount = privateKeyToAccount(`0x${"33".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"44".repeat(32)}`);

const api = createApp(db, { chain: CHAIN });

async function call(method: string, path: string, key: string, payload?: unknown) {
  const response = await api.request(path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A live-on-chain job with a payment of 0.30 waiting for approval (threshold 0.10). */
async function pendingPayment() {
  const seeded = await seedJob({ budget: "1.00", approvalThreshold: "0.10" });
  await db
    .update(jobs)
    .set({
      vaultJobId: vaultJobIdFor(seeded.job.id),
      agentWalletAddress: JOB_WALLET,
      policyVersion: 3,
    })
    .where(eq(jobs.id, seeded.job.id));
  const { authorization } = await requestSpend(
    db,
    seeded.agents[0]!.principal,
    spend("0.30", "op-approve-0001"),
  );
  expect(authorization?.state).toBe("PENDING_APPROVAL");
  const approver = await call("POST", "/approvers", seeded.ownerKey, {
    name: "Finance",
    walletAddress: approverAccount.address,
  });
  expect(approver.status).toBe(201);
  return {
    ...seeded,
    authorizationId: authorization!.id,
    approverKey: approver.body.key as string,
  };
}

async function sign(
  signer: typeof approverAccount,
  jobId: string,
  authorizationId: string,
  overrides: Partial<{ amount: bigint; policyVersion: number; deadline: number }> = {},
) {
  const deadline = overrides.deadline ?? Math.floor(Date.now() / 1000) + 600;
  const policyVersion = overrides.policyVersion ?? 3;
  const typed = approvalTypedData({
    ...CHAIN,
    vaultJobId: vaultJobIdFor(jobId),
    opId: vaultOpIdFor(authorizationId),
    to: JOB_WALLET,
    amount: overrides.amount ?? parseUsdc("0.30"),
    policyVersion,
    deadline,
  });
  return {
    verdict: "APPROVE",
    approverAddress: signer.address,
    signature: await signer.signTypedData(typed),
    deadline,
    policyVersion,
  };
}

async function stateOf(id: string) {
  const [row] = await db.select().from(authorizations).where(eq(authorizations.id, id));
  return row!.state;
}

describe("approvals", () => {
  it("lists a pending payment with the exact message to sign", async () => {
    const { approverKey, authorizationId, job } = await pendingPayment();
    const response = await call("GET", "/approvals", approverKey);
    const pending = response.body.pending as {
      authorizationId: string;
      typedData: { message: Record<string, string> };
    }[];
    expect(pending).toHaveLength(1);
    expect(pending[0]!.authorizationId).toBe(authorizationId);
    expect(pending[0]!.typedData.message).toMatchObject({
      jobId: vaultJobIdFor(job.id),
      opId: vaultOpIdFor(authorizationId),
      amount: "300000",
      policyVersion: "3",
    });
  });

  it("a valid approver signature moves the payment to RESERVED and stores it for the vault", async () => {
    const { approverKey, authorizationId, job } = await pendingPayment();
    const response = await call(
      "POST",
      `/approvals/${authorizationId}`,
      approverKey,
      await sign(approverAccount, job.id, authorizationId),
    );
    expect(response.body).toMatchObject({ state: "RESERVED" });
    const [approval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.authorizationId, authorizationId));
    expect(approval).toMatchObject({
      verdict: "APPROVED",
      approverAddress: approverAccount.address.toLowerCase(),
      policyVersion: 3,
    });
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row!.pending).toBe(0n);
    expect(row!.reserved).toBe(parseUsdc("0.30"));
  });

  it("refuses a signature from a wallet that isn't an approver", async () => {
    const { approverKey, authorizationId, job } = await pendingPayment();
    const response = await call(
      "POST",
      `/approvals/${authorizationId}`,
      approverKey,
      await sign(stranger, job.id, authorizationId),
    );
    expect(response.status).toBe(403);
    expect(await stateOf(authorizationId)).toBe("PENDING_APPROVAL");
  });

  it("refuses a signature over a different amount, even from the real approver", async () => {
    const { approverKey, authorizationId, job } = await pendingPayment();
    const signed = await sign(approverAccount, job.id, authorizationId, {
      amount: parseUsdc("0.01"),
    });
    const response = await call("POST", `/approvals/${authorizationId}`, approverKey, signed);
    expect(response.status).toBe(400);
    expect(await stateOf(authorizationId)).toBe("PENDING_APPROVAL");
  });

  it("refuses an approval signed over old rules", async () => {
    const { approverKey, authorizationId, job } = await pendingPayment();
    const signed = await sign(approverAccount, job.id, authorizationId, { policyVersion: 2 });
    const response = await call("POST", `/approvals/${authorizationId}`, approverKey, signed);
    expect(response.body.error).toBe("STALE_POLICY");
  });

  it("rejecting frees the held money", async () => {
    const { approverKey, authorizationId, job } = await pendingPayment();
    const response = await call("POST", `/approvals/${authorizationId}`, approverKey, {
      verdict: "REJECT",
      note: "too expensive",
    });
    expect(response.body).toMatchObject({ state: "REJECTED" });
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row!.pending).toBe(0n);
  });

  it("decides a payment only once", async () => {
    const { approverKey, authorizationId } = await pendingPayment();
    await call("POST", `/approvals/${authorizationId}`, approverKey, { verdict: "REJECT" });
    const again = await call("POST", `/approvals/${authorizationId}`, approverKey, {
      verdict: "REJECT",
    });
    expect(again.status).toBe(409);
  });

  it("an agent key can't see or decide approvals", async () => {
    const { agents, authorizationId } = await pendingPayment();
    expect((await call("GET", "/approvals", agents[0]!.key)).status).toBe(403);
    expect(
      (await call("POST", `/approvals/${authorizationId}`, agents[0]!.key, { verdict: "REJECT" }))
        .status,
    ).toBe(403);
  });
});
