import { authorizations, decisions, jobs } from "@bursar/db";
import { vaultJobIdFor } from "@bursar/payments";
import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { addPayee } from "../src/services/jobs.js";
import { db, seedJob } from "./support.js";

const VENDOR = "0x9f2a51b3e4d5c6a7b8c9d0e1f2a3b4c5d6e7f809";
const CHAIN = { chainId: 5042002, vault: "0x5Cd51a31fE931D31574Eadd083A0B5c210CA2cB6" as Hex };
const api = createApp(db, { chain: CHAIN });

async function call(method: string, path: string, key: string, payload?: unknown) {
  const response = await api.request(path, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function jobWithVendor(approvalThreshold = "1.00") {
  const seeded = await seedJob({ budget: "1.00", approvalThreshold });
  await addPayee(db, seeded.owner.id, seeded.job.id, {
    kind: "ADDRESS",
    value: VENDOR,
    label: "Colourist",
    category: "contractors",
  });
  return seeded;
}

function invoice(operationId: string, payee = VENDOR, amount = "0.25") {
  return {
    operationId,
    payee,
    amount,
    invoiceRef: "INV-2026-041",
    reasoning: "Colour grade for scene 2, delivered and checked",
  };
}

describe("invoice lane (G11)", () => {
  it("decides an invoice and reserves a payment straight to the vendor", async () => {
    const { agents } = await jobWithVendor();
    const response = await call("POST", "/spend/invoice", agents[0]!.key, invoice("op-inv-00001"));
    expect(response.body).toMatchObject({
      kind: "INVOICE",
      invoiceRef: "INV-2026-041",
      result: "ALLOWED",
      payee: VENDOR,
      category: "contractors",
    });
    const id = (response.body.authorization as { id: string }).id;
    const [auth] = await db.select().from(authorizations).where(eq(authorizations.id, id));
    // No x402 URL: the worker's vault release to this address is the payment itself.
    expect(auth).toMatchObject({ state: "RESERVED", payTo: VENDOR, paymentUrl: null });
  });

  it("refuses a vendor that isn't allow-listed, and records why", async () => {
    const { agents, job } = await jobWithVendor();
    const stranger = "0x1111111111111111111111111111111111111111";
    const response = await call(
      "POST",
      "/spend/invoice",
      agents[0]!.key,
      invoice("op-inv-00002", stranger),
    );
    expect(response.body).toMatchObject({ result: "DENIED", reason: "PAYEE_NOT_ALLOWED" });
    const rows = await db.select().from(decisions).where(eq(decisions.jobId, job.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "INVOICE", invoiceRef: "INV-2026-041" });
  });

  it("a retry with the same operation ID pays once", async () => {
    const { agents } = await jobWithVendor();
    const first = await call("POST", "/spend/invoice", agents[0]!.key, invoice("op-inv-00003"));
    const second = await call("POST", "/spend/invoice", agents[0]!.key, invoice("op-inv-00003"));
    expect(second.body).toMatchObject({ replayed: true, decisionId: first.body.decisionId });
  });

  it("an approver signs over the vendor's address, not the job wallet", async () => {
    const seeded = await jobWithVendor("0.10");
    await db
      .update(jobs)
      .set({
        vaultJobId: vaultJobIdFor(seeded.job.id),
        agentWalletAddress: "0x41048de7f28c92ac2bef61fbc35d7c95e2114b96",
      })
      .where(eq(jobs.id, seeded.job.id));
    const response = await call(
      "POST",
      "/spend/invoice",
      seeded.agents[0]!.key,
      invoice("op-inv-00004"),
    );
    expect(response.body.result).toBe("NEEDS_APPROVAL");

    const approver = await call("POST", "/approvers", seeded.ownerKey, {
      name: "Finance",
      walletAddress: privateKeyToAccount(`0x${"33".repeat(32)}`).address,
    });
    const listing = await call("GET", "/approvals", approver.body.key as string);
    const [pending] = listing.body.pending as { typedData: { message: { to: string } } }[];
    expect(pending!.typedData.message.to.toLowerCase()).toBe(VENDOR);
  });

  it("validates the invoice body", async () => {
    const { agents } = await jobWithVendor();
    const bad = await call("POST", "/spend/invoice", agents[0]!.key, {
      ...invoice("op-inv-00005"),
      payee: "not-an-address",
    });
    expect(bad.status).toBe(400);
  });
});
