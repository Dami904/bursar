import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { keccak256, toBytes, toHex, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

/**
 * Facilitator client for Circle's hosted x402 Facilitator Service.
 *
 * Circle authenticates keyless sellers with a "seller proof": an EIP-712 signature by the payTo
 * key over the purpose, method and hash of the exact request body. The stock HTTPFacilitatorClient
 * builds headers without seeing the body, so it can't produce that proof; this client signs each
 * request itself.
 */

const defaultBaseUrl = "https://api.circle.com/v1/facilitator/x402";
const proofLifetimeSeconds = 300;
const statusPollIntervalMs = 1_000;
const statusPollAttempts = 20;

type Purpose = "verify" | "settle" | "status";

interface SettlementStatusExtension {
  readonly status?: string;
  readonly paymentId?: string;
}

interface StatusResponse {
  readonly status: "pending" | "completed" | "failed";
  readonly reason: string | null;
  readonly transaction: string | null;
  readonly network: string;
  readonly amount: string;
  readonly payer: string;
}

export interface CircleFacilitatorOptions {
  /** The account that controls payTo. It signs every seller proof. */
  readonly seller: PrivateKeyAccount;
  /** CAIP-2 network, for example "eip155:5042002" for Arc testnet. */
  readonly network: `eip155:${number}`;
  readonly baseUrl?: string;
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

function randomNonce(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export class CircleFacilitatorClient implements FacilitatorClient {
  private readonly seller: PrivateKeyAccount;
  private readonly network: `eip155:${number}`;
  private readonly chainId: number;
  private readonly baseUrl: string;

  constructor(options: CircleFacilitatorOptions) {
    this.seller = options.seller;
    this.network = options.network;
    this.chainId = Number(options.network.split(":")[1]);
    this.baseUrl = options.baseUrl ?? defaultBaseUrl;
  }

  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const body = jsonBody({
      x402Version: paymentPayload.x402Version,
      paymentPayload,
      paymentRequirements,
    });
    return (await this.request("verify", "POST", "/verify", body)) as VerifyResponse;
  }

  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const body = jsonBody({
      x402Version: paymentPayload.x402Version,
      paymentPayload,
      paymentRequirements,
    });
    const response = (await this.request("settle", "POST", "/settle", body)) as SettleResponse;
    if (response.success || response.errorReason !== "settlement_pending") {
      return response;
    }
    // Pending is not failure: the transfer may still land. Poll /status before answering.
    const pending = response.extensions?.["settlement-status"] as
      SettlementStatusExtension | undefined;
    if (pending?.paymentId === undefined) {
      return response;
    }
    return this.awaitSettlement(pending.paymentId, response);
  }

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: this.network }],
      extensions: [],
      signers: {},
    };
  }

  private async awaitSettlement(
    paymentId: string,
    pending: SettleResponse,
  ): Promise<SettleResponse> {
    for (let attempt = 0; attempt < statusPollAttempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, statusPollIntervalMs));
      const status = (await this.request(
        "status",
        "GET",
        `/status/${paymentId}`,
        "",
      )) as StatusResponse;
      if (status.status === "completed" && status.transaction !== null) {
        return {
          success: true,
          payer: status.payer,
          transaction: status.transaction,
          network: this.network,
          amount: status.amount,
        };
      }
      if (status.status === "failed") {
        return { ...pending, errorReason: status.reason ?? "settlement_failed" };
      }
    }
    return pending;
  }

  private async request(
    purpose: Purpose,
    method: string,
    path: string,
    body: string,
  ): Promise<unknown> {
    const init: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        "Facilitator-Seller-Proof": await this.proof(purpose, method, body),
      },
    };
    if (method !== "GET") {
      init.body = body;
    }
    const response = await fetch(`${this.baseUrl}${path}`, init);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Circle facilitator ${purpose} failed: HTTP ${response.status} ${text}`);
    }
    return JSON.parse(text) as unknown;
  }

  private async proof(purpose: Purpose, method: string, body: string): Promise<string> {
    const nonce = randomNonce();
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = issuedAt + proofLifetimeSeconds;
    const signature = await this.seller.signTypedData({
      domain: { name: "Circle Facilitator Seller Request", version: "1", chainId: this.chainId },
      types: {
        SellerRequest: [
          { name: "purpose", type: "string" },
          { name: "method", type: "string" },
          { name: "bodyHash", type: "bytes32" },
          { name: "network", type: "string" },
          { name: "payTo", type: "address" },
          { name: "nonce", type: "bytes32" },
          { name: "issuedAt", type: "uint64" },
          { name: "expiresAt", type: "uint64" },
        ],
      },
      primaryType: "SellerRequest",
      message: {
        purpose,
        method: method.toUpperCase(),
        bodyHash: keccak256(toBytes(body)),
        network: this.network,
        payTo: this.seller.address,
        nonce,
        issuedAt: BigInt(issuedAt),
        expiresAt: BigInt(expiresAt),
      },
    });
    const envelope = {
      version: 1,
      signature,
      network: this.network,
      payTo: this.seller.address,
      nonce,
      issuedAt,
      expiresAt,
    };
    return Buffer.from(JSON.stringify(envelope)).toString("base64url");
  }
}
