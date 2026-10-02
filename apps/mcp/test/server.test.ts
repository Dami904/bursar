import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { bursarClient, BursarError, type BursarClient } from "../src/client.js";
import { createServer } from "../src/server.js";

async function connect(bursar: BursarClient) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(bursar).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

function fake(overrides: Partial<BursarClient> = {}): BursarClient {
  const unused = () => Promise.reject(new Error("not used"));
  return {
    budget: unused,
    payees: unused,
    quote: unused,
    marketplace: unused,
    purchase: unused,
    invoice: unused,
    authorization: unused,
    ...overrides,
  };
}

function body(result: Awaited<ReturnType<Client["callTool"]>>) {
  const [first] = result.content as { type: string; text: string }[];
  return JSON.parse(first?.text ?? "null") as Record<string, unknown>;
}

describe("bursar MCP server", () => {
  it("lists the seven spending tools", async () => {
    const client = await connect(fake());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "check_payment",
      "get_budget",
      "list_sellers",
      "pay_invoice",
      "purchase",
      "quote",
      "search_marketplace",
    ]);
  });

  it("searches the job's marketplaces and labels listings as untrusted", async () => {
    const marketplace = vi.fn().mockResolvedValue({
      results: [
        {
          marketplace: "circle-agents",
          service: "Exa",
          method: "POST",
          url: "https://api.exa.ai/search",
          price: "0.007",
          description: "Web search",
        },
      ],
      unavailable: [],
    });
    const client = await connect(fake({ marketplace }));
    const out = body(
      await client.callTool({ name: "search_marketplace", arguments: { query: "web search" } }),
    );
    expect(marketplace).toHaveBeenCalledWith("web search", undefined);
    expect(out.untrusted_marketplace_listings).toEqual([
      expect.objectContaining({ service: "Exa", url: "https://api.exa.ai/search" }),
    ]);
  });

  it("buys through Bursar and labels the seller's content as untrusted", async () => {
    const purchase = vi.fn().mockResolvedValue({
      result: "ALLOWED",
      amount: "0.02",
      remaining: "1.98",
      purchase: { id: "auth-1", state: "SETTLED", deliverable: "INT. OFFICE — NIGHT" },
    });
    const client = await connect(fake({ purchase }));
    const out = body(
      await client.callTool({
        name: "purchase",
        arguments: {
          url: "https://seller.example/v1/script-line",
          max_price: "0.05",
          reasoning: "Scene 1",
        },
      }),
    );
    expect(purchase).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://seller.example/v1/script-line", maxPrice: "0.05" }),
    );
    expect(out).toMatchObject({
      decision: "ALLOWED",
      payment_id: "auth-1",
      state: "SETTLED",
      next: null,
      untrusted_seller_content: "INT. OFFICE — NIGHT",
    });
    expect(String(out.operation_id)).toMatch(/^mcp-/);
  });

  it("keeps the caller's operation id so retries are never paid twice", async () => {
    const purchase = vi.fn().mockResolvedValue({ result: "ALLOWED", purchase: null });
    const client = await connect(fake({ purchase }));
    for (let i = 0; i < 2; i += 1) {
      await client.callTool({
        name: "purchase",
        arguments: {
          url: "https://s.example/a",
          max_price: "0.01",
          reasoning: "r",
          operation_id: "op-film-0007",
        },
      });
    }
    expect(purchase.mock.calls.map(([input]) => input.operationId)).toEqual([
      "op-film-0007",
      "op-film-0007",
    ]);
  });

  it("tells the agent to check back when a payment waits for approval", async () => {
    const invoice = vi.fn().mockResolvedValue({
      result: "NEEDS_APPROVAL",
      amount: "0.25",
      purchase: { id: "auth-2", state: "PENDING_APPROVAL" },
    });
    const client = await connect(fake({ invoice }));
    const out = body(
      await client.callTool({
        name: "pay_invoice",
        arguments: {
          payee: "0x4A25223e00000000000000000000000000000000",
          amount: "0.25",
          invoice_ref: "VO-12",
          reasoning: "Narration delivered",
        },
      }),
    );
    expect(out.state).toBe("PENDING_APPROVAL");
    expect(String(out.next)).toContain("check_payment");
  });

  it("returns Bursar's refusal as a tool error with its code", async () => {
    const quote = vi
      .fn()
      .mockRejectedValue(new BursarError(403, "PAYEE_NOT_ALLOWED", "Not on the allow-list"));
    const client = await connect(fake({ quote }));
    const result = await client.callTool({
      name: "quote",
      arguments: { url: "https://evil.example/x" },
    });
    expect(result.isError).toBe(true);
    expect(body(result)).toEqual({ error: "PAYEE_NOT_ALLOWED", message: "Not on the allow-list" });
  });

  it("rejects operation ids the API would refuse", async () => {
    const purchase = vi.fn();
    const client = await connect(fake({ purchase }));
    const result = await client.callTool({
      name: "purchase",
      arguments: {
        url: "https://s.example/a",
        max_price: "0.01",
        reasoning: "r",
        operation_id: "op-1",
      },
    });
    expect(result.isError).toBe(true);
    expect(purchase).not.toHaveBeenCalled();
  });

  it("rejects malformed amounts before calling Bursar", async () => {
    const invoice = vi.fn();
    const client = await connect(fake({ invoice }));
    const result = await client.callTool({
      name: "pay_invoice",
      arguments: {
        payee: "0x4A25223e00000000000000000000000000000000",
        amount: "lots",
        invoice_ref: "x",
        reasoning: "r",
      },
    });
    expect(result.isError).toBe(true);
    expect(invoice).not.toHaveBeenCalled();
  });
});

describe("bursarClient", () => {
  it("sends the agent key and turns API errors into BursarError", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "JOB_BUDGET_EXCEEDED", message: "Over budget" }), {
        status: 409,
      }),
    );
    const client = bursarClient("https://api.example/", "bk_agent_test", fetchFn);
    await expect(client.budget()).rejects.toMatchObject({
      code: "JOB_BUDGET_EXCEEDED",
      status: 409,
    });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example/spend/budget");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer bk_agent_test");
  });
});
