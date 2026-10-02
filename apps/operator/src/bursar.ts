/**
 * The operator's only way to act: Bursar's HTTP API with one agent key. Everything the model does
 * goes through here, so it can never spend more than that key's job and policy allow.
 */

export class BursarError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** How a seller is called: GET, or POST with a JSON body (search and scraping sellers). */
export interface SellerRequest {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
}

export interface Bursar {
  budget(): Promise<unknown>;
  payees(): Promise<unknown>;
  quote(url: string, request?: SellerRequest): Promise<unknown>;
  /** Searches the marketplaces on the job's allow-list. */
  marketplace(query: string, limit?: number): Promise<unknown>;
  purchase(
    input: {
      operationId: string;
      url: string;
      maxPrice: string;
      reasoning: string;
    } & SellerRequest,
  ): Promise<Record<string, unknown>>;
  invoice(input: {
    operationId: string;
    payee: string;
    amount: string;
    invoiceRef: string;
    reasoning: string;
  }): Promise<Record<string, unknown>>;
  authorization(id: string): Promise<Record<string, unknown>>;
  spawnHelper(input: {
    name: string;
    role: string;
    spendLimit?: string;
  }): Promise<{ key: string; agent: { id: string } }>;
  recordRun(input: Record<string, unknown>): Promise<unknown>;
  /** A client acting as another agent (a helper this operator spawned). */
  as(key: string): Bursar;
}

export function bursarClient(baseUrl: string, key: string): Bursar {
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const init: RequestInit = {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(90_000),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${baseUrl}${path}`, init);
    const json = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
    if (!response.ok) {
      throw new BursarError(
        response.status,
        json.error ?? "HTTP_ERROR",
        json.message ?? `HTTP ${response.status}`,
      );
    }
    return json;
  }
  return {
    budget: () => call("GET", "/spend/budget"),
    payees: () => call("GET", "/spend/payees"),
    quote: (url, request) => call("POST", "/spend/quote", { url, ...request }),
    marketplace: (query, limit = 15) =>
      call(
        "GET",
        `/spend/marketplace?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(limit))}`,
      ),
    purchase: (input) => call("POST", "/spend/purchase", input) as Promise<Record<string, unknown>>,
    invoice: (input) => call("POST", "/spend/invoice", input) as Promise<Record<string, unknown>>,
    authorization: (id) =>
      call("GET", `/spend/authorizations/${encodeURIComponent(id)}`) as Promise<
        Record<string, unknown>
      >,
    spawnHelper: (input) =>
      call("POST", "/spend/subagent", input) as Promise<{ key: string; agent: { id: string } }>,
    recordRun: (input) => call("POST", "/spend/runs", input),
    as: (other) => bursarClient(baseUrl, other),
  };
}
