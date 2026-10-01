/**
 * Bursar's agent API with one agent key. Kept free of workspace imports so this package can be
 * published and run with npx on its own.
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

export type Json = Record<string, unknown>;

/** Sellers that take a JSON body (search, scraping) are called with POST. GET is the default. */
export interface SellerRequest {
  method?: "GET" | "POST" | undefined;
  body?: Record<string, unknown> | undefined;
}

export interface BursarClient {
  budget(): Promise<Json>;
  payees(): Promise<Json>;
  quote(url: string, request?: SellerRequest): Promise<Json>;
  purchase(input: {
    operationId: string;
    url: string;
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
    maxPrice: string;
    reasoning: string;
  }): Promise<Json>;
  invoice(input: {
    operationId: string;
    payee: string;
    amount: string;
    invoiceRef: string;
    reasoning: string;
  }): Promise<Json>;
  authorization(id: string): Promise<Json>;
}

export function bursarClient(
  baseUrl: string,
  key: string,
  fetchFn: typeof fetch = fetch,
): BursarClient {
  const base = baseUrl.replace(/\/+$/, "");
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Json> {
    const init: RequestInit = {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(90_000),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetchFn(`${base}${path}`, init);
    const json = (await response.json().catch(() => ({}))) as Json;
    if (!response.ok) {
      throw new BursarError(
        response.status,
        typeof json.error === "string" ? json.error : "HTTP_ERROR",
        typeof json.message === "string" ? json.message : `HTTP ${response.status}`,
      );
    }
    return json;
  }
  return {
    budget: () => call("GET", "/spend/budget"),
    payees: () => call("GET", "/spend/payees"),
    quote: (url, request) => call("POST", "/spend/quote", { url, ...request }),
    purchase: (input) => call("POST", "/spend/purchase", input),
    invoice: (input) => call("POST", "/spend/invoice", input),
    authorization: (id) => call("GET", `/spend/authorizations/${encodeURIComponent(id)}`),
  };
}
