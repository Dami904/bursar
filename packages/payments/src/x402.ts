import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { Hex } from "viem";
import { GATEWAY_NETWORKS, isGatewayRequirement } from "./gateway.js";
import { assertFetchable, publicFetchOptions } from "./ssrf.js";

const requestTimeoutMs = 15_000;
/** Paid responses returned to agents are capped; nobody needs a megabyte in a decision log. */
const maxBodyBytes = 64 * 1024;

export class QuoteError extends Error {
  override readonly name = "QuoteError";
}

export interface Quote {
  readonly url: string;
  readonly paymentRequired: PaymentRequired;
  /** The one option Bursar will pay with: exact scheme, our network, USDC. */
  readonly requirements: PaymentRequirements;
  readonly amount: bigint;
  readonly payTo: string;
  /** VAULT: an ordinary on-chain x402 payment. GATEWAY: Circle's batched (Nanopayments) scheme. */
  readonly rail: "VAULT" | "GATEWAY";
}

export interface QuoteOptions {
  /** CAIP-2 network Bursar pays on, e.g. "eip155:5042002". */
  readonly network: string;
  /** USDC contract address on that network. */
  readonly asset: string;
  readonly allowPrivateHosts: boolean;
}

async function readCapped(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > maxBodyBytes ? `${text.slice(0, maxBodyBytes)}\n[truncated]` : text;
}

/**
 * Asks a seller what a resource costs, without paying: requests it and reads the 402 challenge.
 * Redirects are refused (a redirect could point at an address the SSRF check never saw).
 */
export async function quote(url: string, options: QuoteOptions): Promise<Quote> {
  const safe = await assertFetchable(url, options.allowPrivateHosts);
  let response: Response;
  try {
    response = await fetch(safe, {
      ...publicFetchOptions(options.allowPrivateHosts),
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    throw new QuoteError(`The seller didn't answer: ${(error as Error).message}`);
  }
  if (response.status !== 402) {
    throw new QuoteError(`Expected 402 Payment Required, got HTTP ${response.status}`);
  }
  const header = response.headers.get("payment-required");
  if (header === null) throw new QuoteError("The 402 response has no PAYMENT-REQUIRED header");
  let paymentRequired: PaymentRequired;
  try {
    paymentRequired = decodePaymentRequiredHeader(header);
  } catch {
    throw new QuoteError("The PAYMENT-REQUIRED header isn't valid x402");
  }
  const usable = paymentRequired.accepts.filter(
    (option) =>
      option.scheme === "exact" &&
      option.network === options.network &&
      option.asset.toLowerCase() === options.asset.toLowerCase() &&
      (!isGatewayRequirement(option) || GATEWAY_NETWORKS[option.network] !== undefined),
  );
  // A plain on-chain payment when the seller offers one (the vault checks each payment itself);
  // Circle's batched scheme when that's all it takes, which is how sub-cent sellers price.
  const requirements =
    usable.find((option) => !isGatewayRequirement(option)) ??
    usable.find((option) => isGatewayRequirement(option));
  if (requirements === undefined) {
    throw new QuoteError(`The seller doesn't accept USDC on ${options.network}`);
  }
  if (!/^\d+$/.test(requirements.amount) || !/^0x[0-9a-fA-F]{40}$/.test(requirements.payTo)) {
    throw new QuoteError("The seller's payment requirements are malformed");
  }
  return {
    url: safe.toString(),
    paymentRequired,
    requirements,
    amount: BigInt(requirements.amount),
    payTo: requirements.payTo,
    rail: isGatewayRequirement(requirements) ? "GATEWAY" : "VAULT",
  };
}

export interface CatalogEntry {
  readonly url: string;
  /** Seller-written: untrusted text. */
  readonly description: string;
}

const maxCatalogEntries = 50;
const maxDescriptionChars = 300;

/**
 * Reads a seller's catalog at `<origin>/.well-known/x402` so an agent knows which URLs exist.
 * Same SSRF guard as `quote`, no redirects, short timeout. Only same-origin, http(s) entries are
 * kept (a catalog can't point the agent at another host), and no prices: the 402 quote is the only
 * price Bursar trusts.
 */
export async function discover(
  origin: string,
  options: Pick<QuoteOptions, "allowPrivateHosts">,
): Promise<CatalogEntry[]> {
  const base = await assertFetchable(origin, options.allowPrivateHosts);
  const catalogUrl = new URL("/.well-known/x402", base.origin);
  let response: Response;
  try {
    response = await fetch(catalogUrl, {
      ...publicFetchOptions(options.allowPrivateHosts),
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(3_000),
    });
  } catch (error) {
    throw new QuoteError(`The seller didn't answer: ${(error as Error).message}`);
  }
  if (response.status !== 200) {
    throw new QuoteError(`No catalog at ${catalogUrl.pathname} (HTTP ${response.status})`);
  }
  let body: unknown;
  try {
    body = JSON.parse(await readCapped(response));
  } catch {
    throw new QuoteError("The seller's catalog isn't valid JSON");
  }
  const resources = (body as { resources?: unknown }).resources;
  if (!Array.isArray(resources)) throw new QuoteError("The seller's catalog has no resources");
  const entries: CatalogEntry[] = [];
  for (const item of resources.slice(0, maxCatalogEntries)) {
    const { url, description } = (item ?? {}) as { url?: unknown; description?: unknown };
    if (typeof url !== "string") continue;
    let resolved: URL;
    try {
      resolved = new URL(url, base.origin);
    } catch {
      continue;
    }
    if (resolved.origin !== base.origin) continue;
    entries.push({
      url: resolved.toString(),
      description: typeof description === "string" ? description.slice(0, maxDescriptionChars) : "",
    });
  }
  return entries;
}

/** Anything that can sign EIP-712 typed data for an address (a Circle wallet in production). */
export interface TypedDataSigner {
  readonly address: Hex;
  signTypedData(message: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<Hex>;
}

export interface SignedPayment {
  readonly header: string;
  readonly payer: string;
  /** EIP-3009 nonce: USDC refuses to use it twice, which makes the payment idempotent. */
  readonly nonce: string;
  readonly validBefore: Date;
}

/**
 * Signs an EIP-3009 payment for exactly the quoted requirements. Signing moves no money: the
 * caller persists payer, nonce and validBefore before sending the header.
 */
export async function signPayment(
  signer: TypedDataSigner,
  paymentRequired: PaymentRequired,
  requirements: PaymentRequirements,
): Promise<SignedPayment> {
  // Same payload shape either way (an EIP-3009 authorization and its signature); the batched
  // scheme signs against Circle's GatewayWallet instead of USDC itself.
  const result = (
    isGatewayRequirement(requirements)
      ? await new BatchEvmScheme(signer).createPaymentPayload(
          paymentRequired.x402Version,
          requirements,
        )
      : await new ExactEvmScheme(signer).createPaymentPayload(
          paymentRequired.x402Version,
          requirements,
        )
  ) as {
    x402Version: number;
    payload: Record<string, unknown>;
    extensions?: Record<string, unknown>;
  };
  const payload: PaymentPayload = {
    x402Version: result.x402Version,
    ...(paymentRequired.resource === undefined ? {} : { resource: paymentRequired.resource }),
    accepted: requirements,
    payload: result.payload,
    ...(result.extensions === undefined ? {} : { extensions: result.extensions }),
  };
  const authorization = (result.payload as { authorization?: Record<string, unknown> })
    .authorization;
  if (authorization === undefined) throw new Error("x402 payload has no EIP-3009 authorization");
  return {
    header: encodePaymentSignatureHeader(payload),
    payer: String(authorization.from),
    nonce: String(authorization.nonce),
    validBefore: new Date(Number(authorization.validBefore) * 1000),
  };
}

export type PaymentOutcome =
  /** The seller delivered and reported a settlement transaction. */
  | { readonly kind: "PAID"; readonly body: string; readonly settlement: SettleResponse }
  /** The seller positively refused the payment: nothing can have moved. */
  | { readonly kind: "REFUSED"; readonly status: number; readonly body: string }
  /** No usable answer (timeout, dropped connection, 5xx): money may or may not have moved. */
  | { readonly kind: "UNKNOWN"; readonly reason: string };

/** Sends a signed payment. Never throws for network trouble: that's an UNKNOWN outcome. */
export async function sendPayment(
  url: string,
  header: string,
  options: { readonly allowPrivateHosts?: boolean } = {},
): Promise<PaymentOutcome> {
  let response: Response;
  try {
    // Checked again at connection time: the seller's DNS may have changed since the quote.
    response = await fetch(url, {
      ...publicFetchOptions(options.allowPrivateHosts === true),
      method: "GET",
      redirect: "manual",
      headers: { "PAYMENT-SIGNATURE": header },
      signal: AbortSignal.timeout(requestTimeoutMs * 2),
    });
  } catch (error) {
    return { kind: "UNKNOWN", reason: `No response from the seller: ${(error as Error).message}` };
  }
  const body = await readCapped(response).catch(() => "");
  const settlementHeader = response.headers.get("payment-response");
  const settlement = settlementHeader === null ? null : safeDecode(settlementHeader);
  if (response.ok && settlement?.success === true) {
    return { kind: "PAID", body, settlement };
  }
  if (response.status >= 500 || (response.ok && settlement === null)) {
    return { kind: "UNKNOWN", reason: `HTTP ${response.status} without a settlement receipt` };
  }
  return { kind: "REFUSED", status: response.status, body };
}

function safeDecode(header: string): SettleResponse | null {
  try {
    return decodePaymentResponseHeader(header);
  } catch {
    return null;
  }
}
