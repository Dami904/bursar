import { createHash } from "node:crypto";
import { formatUsdc } from "@bursar/money";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import type { Hex } from "viem";
import type { TypedDataSigner } from "./x402.js";

export interface JobWallet {
  readonly id: string;
  readonly address: Hex;
}

export interface TransferRequest {
  readonly wallet: JobWallet;
  readonly token: Hex;
  readonly to: Hex;
  readonly amount: bigint;
  /** Same key, same transfer: a retry never sends the money twice. */
  readonly idempotencyKey: string;
}

export type TransferState = "PENDING" | "COMPLETE" | "FAILED";

/** Creates per-job wallets, signs with them and moves money out of them. Circle in production. */
export interface WalletProvider {
  createJobWallet(label: string): Promise<JobWallet>;
  signer(wallet: JobWallet): TypedDataSigner;
  /** Starts a token transfer. Asynchronous: poll transferStatus for the outcome. */
  transfer(request: TransferRequest): Promise<{ readonly id: string }>;
  transferStatus(
    id: string,
  ): Promise<{ readonly state: TransferState; readonly txHash: string | null }>;
}

/** A stable UUID derived from any string, for idempotency keys that must survive restarts. */
export function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = ((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface CircleConfig {
  readonly apiKey: string;
  readonly entitySecret: string;
  readonly walletSetId: string;
  /** Circle's chain name, e.g. "ARC-TESTNET". */
  readonly blockchain: "ARC-TESTNET" | "ARC";
}

/**
 * Circle developer-controlled wallets: key-based, so they work on a hosted server (unlike the CLI,
 * whose login needs an emailed code). Each job gets its own EOA wallet.
 */
export class CircleWalletProvider implements WalletProvider {
  private readonly client;

  constructor(private readonly config: CircleConfig) {
    this.client = initiateDeveloperControlledWalletsClient({
      apiKey: config.apiKey,
      entitySecret: config.entitySecret,
    });
  }

  async createJobWallet(label: string): Promise<JobWallet> {
    const response = await this.client.createWallets({
      walletSetId: this.config.walletSetId,
      blockchains: [this.config.blockchain],
      count: 1,
      accountType: "EOA",
      metadata: [{ name: label.slice(0, 50) }],
    });
    const wallet = response.data?.wallets?.[0];
    if (wallet === undefined) throw new Error("Circle returned no wallet");
    return { id: wallet.id, address: wallet.address as Hex };
  }

  async transfer(request: TransferRequest): Promise<{ readonly id: string }> {
    const response = await this.client.createTransaction({
      walletAddress: request.wallet.address,
      blockchain: this.config.blockchain,
      tokenAddress: request.token,
      amount: [formatUsdc(request.amount, { minDecimals: 0 })],
      destinationAddress: request.to,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey: request.idempotencyKey,
    });
    const id = response.data?.id;
    if (id === undefined) throw new Error("Circle returned no transaction id");
    return { id };
  }

  async transferStatus(id: string) {
    const response = await this.client.getTransaction({ id });
    const tx = response.data?.transaction;
    if (tx === undefined) throw new Error(`Circle has no transaction ${id}`);
    const state: TransferState =
      tx.state === "COMPLETE" || tx.state === "CONFIRMED" || tx.state === "CLEARED"
        ? "COMPLETE"
        : tx.state === "FAILED" || tx.state === "CANCELLED" || tx.state === "DENIED"
          ? "FAILED"
          : "PENDING";
    return { state, txHash: tx.txHash ?? null };
  }

  signer(wallet: JobWallet): TypedDataSigner {
    const client = this.client;
    return {
      address: wallet.address,
      async signTypedData(message) {
        const domainTypes = Object.entries(message.domain)
          .filter(([, value]) => value !== undefined)
          .map(([name]) => ({ name, type: domainFieldType[name] ?? "string" }));
        const response = await client.signTypedData({
          walletId: wallet.id,
          data: JSON.stringify(
            {
              ...message,
              types: { EIP712Domain: domainTypes, ...message.types },
            },
            (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
          ),
        });
        const signature = response.data?.signature;
        if (signature === undefined) throw new Error("Circle returned no signature");
        return signature as Hex;
      },
    };
  }
}

const domainFieldType: Record<string, string> = {
  name: "string",
  version: "string",
  chainId: "uint256",
  verifyingContract: "address",
  salt: "bytes32",
};
