import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Decision, JobEvent } from "../lib/api.js";
import { txUrl } from "../lib/config.js";
import { Activity } from "./Activity.js";

const row = (over: Partial<Decision>): Decision => ({
  id: "d1",
  at: new Date().toISOString(),
  job: { id: "j1", title: "Image generation" },
  agent: { id: "a1", name: "Operator", role: "operator" },
  kind: "PURCHASE",
  payee: "https://seller.example",
  payeeLabel: null,
  invoiceRef: null,
  amount: "0.02",
  reasoning: "needed",
  result: "ALLOWED",
  reason: null,
  state: "SETTLED",
  authorizationId: "x",
  paymentUrl: "https://seller.example/v1/insight",
  paymentTx: null,
  ...over,
});

function page(decisions: Decision[], events: JobEvent[] = []) {
  const client = new QueryClient();
  client.setQueryData(["activity"], { decisions });
  client.setQueryData(["job-events"], { events });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Activity />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the daybook", () => {
  it("counts each outcome, names the job and links every line to its voucher", () => {
    const html = page([
      row({ id: "paid-1" }),
      row({ id: "paid-2", amount: "0.03" }),
      row({ id: "stopped", result: "DENIED", state: null, reason: "PAYEE_NOT_ALLOWED" }),
    ]);
    expect(html).toContain("Everything");
    expect(html).toMatch(/Paid[\s\S]*?>2</);
    expect(html).toMatch(/Blocked[\s\S]*?>1</);
    expect(html).toContain("Image generation");
    expect(html).toContain("Seller not allowed");
    expect(html).toContain('href="/app/decisions/paid-1"');
    expect(html).toContain("Today");
  });

  it("shows the jobs' own moments between the payments: created, funded, closed", () => {
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const html = page(
      [row({ id: "paid-1", at: at(30) })],
      [
        { id: "e3", at: at(5), kind: "closed", jobId: "j1", jobTitle: "Flier", txHash: "0xabc" },
        { id: "e2", at: at(40), kind: "funded", jobId: "j1", jobTitle: "Flier", txHash: "0xdef" },
        { id: "e1", at: at(50), kind: "created", jobId: "j1", jobTitle: "Flier", txHash: null },
      ],
    );
    expect(html).toContain("Job created");
    expect(html).toContain("USDC paid into the job");
    expect(html).toContain("Job closed");
    expect(html).toContain(txUrl("0xabc"));
    // Newest first: closed, then the payment, then funded, then created.
    const order = ["Job closed", "Image generation", "USDC paid into", "Job created"].map((t) =>
      html.indexOf(t),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  it("shows a picture a purchase delivered in place of the agent's mark", () => {
    const html = page([
      row({
        media: [
          { url: "https://blob.test/a.png", kind: "image", contentType: "image/png", bytes: 1 },
        ],
      }),
    ]);
    expect(html).toContain("<img");
  });

  it("says so when there's nothing yet", () => {
    expect(page([])).toContain("Nothing in the daybook yet");
  });

  it("beside the list, opens the first line with a link to its payment on Arc", () => {
    const client = new QueryClient();
    const hash = "0x" + "cd".repeat(32);
    client.setQueryData(["activity"], { decisions: [row({ id: "paid-1" })] });
    client.setQueryData(["evidence", false, "paid-1"], {
      job: { id: "j1", title: "Image generation" },
      agent: { name: "Operator" },
      decision: {
        at: new Date().toISOString(),
        kind: "PURCHASE",
        payee: "https://seller.example",
        invoiceRef: null,
        amount: "0.02",
        reasoning: "needed",
        result: "ALLOWED",
        reason: null,
        checks: [{ check: "JOB_NOT_ACTIVE", passed: true }],
      },
      payment: {
        state: "SETTLED",
        rail: "VAULT",
        vaultTx: hash,
        paymentTx: hash,
        reason: null,
      },
      approval: null,
      audit: [],
      anchor: { anchorSeq: 9, txHash: "0x" + "ef".repeat(32), at: new Date().toISOString() },
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Activity />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html).toContain("Why it went through");
    expect(html).toContain("All 1 rules passed");
    expect(html).toContain(txUrl(hash));
    expect(html).toContain("Sealed on Arc #9");
  });
});
