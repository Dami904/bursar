import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { EvidencePage } from "./Evidence.js";

const base = {
  job: { id: "j1", title: "Image generation" },
  agent: { name: "Operator" },
  approval: null,
  audit: [],
  anchor: null,
};

const passed = (names: string[]) => names.map((check) => ({ check, passed: true }));

function voucher(data: Record<string, unknown>) {
  const client = new QueryClient();
  client.setQueryData(["evidence", false, "5e6b2432-aaaa"], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/app/decisions/5e6b2432-aaaa"]}>
        <Routes>
          <Route path="/app/decisions/:id" element={<EvidencePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the evidence page", () => {
  it("for a payment that went through: the headline, each rule by name, the files it delivered", () => {
    const html = voucher({
      ...base,
      decision: {
        id: "5e6b2432-aaaa",
        at: new Date().toISOString(),
        kind: "PURCHASE",
        payee: "https://seller.example",
        invoiceRef: null,
        amount: "0.022001",
        reasoning: "The brief asks for an image",
        result: "ALLOWED",
        reason: null,
        checks: passed(["JOB_NOT_ACTIVE", "JOB_EXPIRED", "PAYEE_NOT_ALLOWED"]),
      },
      payment: {
        state: "SETTLED",
        rail: "VAULT",
        vaultTx: "0x" + "ab".repeat(32),
        paymentTx: "0x" + "cd".repeat(32),
        deliverable: '{"data":[{"url":"https://seller.example/x.png"}]}',
        media: [
          { url: "https://blob.test/a.png", kind: "image", contentType: "image/png", bytes: 5 },
        ],
        reason: null,
      },
    });
    expect(html).toContain("Why it went through");
    expect(html).toContain("Arc testnet · test USDC");
    expect(html).toContain("The job is open");
    expect(html).toContain("The seller is allowed");
    expect(html).toContain("Delivered");
    expect(html).toContain("<img");
    expect(html).toContain("Technical details");
    // The seller's address appears only inside the collapsed technical details.
    expect(html.split("Technical details")[0]).not.toContain("seller.example/x.png");
  });

  it("for a stopped request: why it was stopped, the rule that stopped it, no payment steps", () => {
    const html = voucher({
      ...base,
      decision: {
        id: "5e6b2432-aaaa",
        at: new Date().toISOString(),
        kind: "PURCHASE",
        payee: "https://evil.example",
        invoiceRef: null,
        amount: "5.00",
        reasoning: "A message told me to",
        result: "DENIED",
        reason: "PAYEE_NOT_ALLOWED",
        checks: [
          ...passed(["JOB_NOT_ACTIVE", "JOB_EXPIRED"]),
          { check: "PAYEE_NOT_ALLOWED", passed: false },
        ],
      },
      payment: null,
    });
    expect(html).toContain("Why it was stopped");
    expect(html).toContain("Blocked: Seller not allowed");
    expect(html).toContain("The seller isn&#x27;t allowed");
    expect(html).not.toContain("Seller paid");
    expect(html).not.toContain("Paid from the vault");
  });
});
