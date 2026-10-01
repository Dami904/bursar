import type { PaymentRequirements } from "@x402/core/types";
import { encodeFunctionData, pad, parseAbi, zeroAddress, type Hex } from "viem";

/**
 * Circle Gateway (Nanopayments): sub-cent x402 payments signed off-chain against a Gateway
 * balance and settled by Circle in batches. Bursar funds each job's balance from the vault as a
 * small float, then pays each call from it (see apps/worker/src/floats.ts).
 */

/** The x402 `extra.name` Circle's batched scheme uses; anything else is a plain on-chain payment. */
export const GATEWAY_SCHEME_NAME = "GatewayWalletBatched";

export interface GatewayNetwork {
  /** Circle's GatewayWallet contract: deposits go here, and it's the EIP-712 verifying contract. */
  readonly gatewayWallet: Hex;
  /** Circle's GatewayMinter: mints a withdrawal's USDC to its recipient (anyone may submit). */
  readonly gatewayMinter: Hex;
  /** Circle's Gateway domain id for the chain (used by the balances API). */
  readonly domain: number;
  readonly apiUrl: string;
}

/** Networks Bursar can pay through Gateway, by CAIP-2 id (checked against Circle's API). */
export const GATEWAY_NETWORKS: Record<string, GatewayNetwork> = {
  "eip155:5042002": {
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
    domain: 26,
    apiUrl: "https://gateway-api-testnet.circle.com/v1",
  },
  // Arc mainnet: addresses from Circle's Gateway docs, confirmed against GET /v1/info.
  "eip155:5042": {
    gatewayWallet: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE",
    gatewayMinter: "0x2222222d7164433c4C09B0b0D809a9b52C04C205",
    domain: 26,
    apiUrl: "https://gateway-api.circle.com/v1",
  },
};

/** Adds a Gateway deployment Bursar should pay through: a local chain with a stand-in API, say. */
export function registerGatewayNetwork(network: string, config: GatewayNetwork): void {
  GATEWAY_NETWORKS[network] = config;
}

export function isGatewayRequirement(requirements: PaymentRequirements): boolean {
  return (requirements.extra as { name?: unknown } | undefined)?.name === GATEWAY_SCHEME_NAME;
}

export class GatewayError extends Error {
  override readonly name = "GatewayError";
}

function networkOf(network: string): GatewayNetwork {
  const config = GATEWAY_NETWORKS[network];
  if (config === undefined) throw new GatewayError(`Gateway isn't set up for ${network}`);
  return config;
}

async function gatewayFetch(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new GatewayError(`Gateway didn't answer: ${(error as Error).message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new GatewayError(`Gateway answered HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GatewayError("Gateway answered with invalid JSON");
  }
}

/** Parses a USDC decimal string ("0.097") into micro-USDC. */
function toMicros(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6) || "0");
}

/** What `address` can spend through Gateway right now, in micro-USDC. */
export async function gatewayAvailable(network: string, address: string): Promise<bigint> {
  const config = networkOf(network);
  const data = (await gatewayFetch(`${config.apiUrl}/balances`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: "USDC",
      sources: [{ depositor: address, domain: config.domain }],
    }),
  })) as { balances?: { balance?: string }[] };
  const balance = data.balances?.[0]?.balance;
  return typeof balance === "string" ? toMicros(balance) : 0n;
}

export interface GatewayTransfer {
  readonly id: string;
  /** Circle's status, e.g. "received" (accepted) or later settlement states. */
  readonly status: string;
  readonly amount: bigint;
  readonly nonce: string;
  readonly txHash: string | null;
}

/** Looks up a signed Gateway payment by its EIP-3009 nonce: null if Gateway never received it. */
export async function findGatewayTransfer(
  network: string,
  from: string,
  nonce: string,
): Promise<GatewayTransfer | null> {
  const config = networkOf(network);
  // Circle's API wants the CAIP-2 colon unescaped (as its own SDK sends it).
  const query = new URLSearchParams({ from, nonce, network }).toString().replaceAll("%3A", ":");
  const data = (await gatewayFetch(`${config.apiUrl}/x402/transfers?${query}`, {
    method: "GET",
  })) as { transfers?: Record<string, unknown>[] };
  const hit = data.transfers?.find((t) => String(t.nonce).toLowerCase() === nonce.toLowerCase());
  if (hit === undefined) return null;
  return {
    id: String(hit.id),
    status: String(hit.status),
    amount: BigInt(String(hit.amount ?? "0")),
    nonce: String(hit.nonce),
    txHash: typeof hit.txHash === "string" ? hit.txHash : null,
  };
}

const erc20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const gatewayWallet = parseAbi(["function deposit(address token, uint256 value)"]);

/** The two calls that move a float from the job wallet into its Gateway balance. */
export function gatewayDepositCalls(network: string, usdc: Hex, amount: bigint) {
  const config = networkOf(network);
  return {
    approve: {
      contract: usdc,
      signature: "approve(address,uint256)",
      params: [config.gatewayWallet, amount.toString()],
      data: encodeFunctionData({
        abi: erc20,
        functionName: "approve",
        args: [config.gatewayWallet, amount],
      }),
    },
    deposit: {
      contract: config.gatewayWallet,
      signature: "deposit(address,uint256)",
      params: [usdc, amount.toString()],
      data: encodeFunctionData({
        abi: gatewayWallet,
        functionName: "deposit",
        args: [usdc, amount],
      }),
    },
  } as const;
}

// ------------------------------------------------------------------ withdrawals

/**
 * Taking money back out of Gateway, on the same chain: the depositor signs a burn intent, Circle
 * attests it (charging a flat fee from the balance), and anyone submits the attestation to the
 * GatewayMinter, which mints the USDC to the recipient. Circle only burns the balance once it sees
 * the mint, so an attestation that's never minted expires and the balance comes back.
 */
export interface BurnIntent {
  readonly maxBlockHeight: bigint;
  readonly maxFee: bigint;
  readonly spec: {
    readonly version: number;
    readonly sourceDomain: number;
    readonly destinationDomain: number;
    readonly sourceContract: Hex;
    readonly destinationContract: Hex;
    readonly sourceToken: Hex;
    readonly destinationToken: Hex;
    readonly sourceDepositor: Hex;
    readonly destinationRecipient: Hex;
    readonly sourceSigner: Hex;
    readonly destinationCaller: Hex;
    readonly value: bigint;
    readonly salt: Hex;
    readonly hookData: Hex;
  };
}

const bytes32 = (address: string) => pad(address.toLowerCase() as Hex, { size: 32 });
const jsonSafe = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

/**
 * A same-chain withdrawal of `available` from `depositor`'s Gateway balance to `recipient`, less
 * Circle's fee (read from Circle's estimate). Returns null when the balance wouldn't cover the fee.
 */
export async function gatewayWithdrawIntent(
  network: string,
  params: {
    readonly usdc: Hex;
    readonly depositor: Hex;
    readonly recipient: Hex;
    readonly available: bigint;
    readonly salt: Hex;
  },
): Promise<BurnIntent | null> {
  const config = networkOf(network);
  const spec = {
    version: 1,
    sourceDomain: config.domain,
    destinationDomain: config.domain,
    sourceContract: bytes32(config.gatewayWallet),
    destinationContract: bytes32(config.gatewayMinter),
    sourceToken: bytes32(params.usdc),
    destinationToken: bytes32(params.usdc),
    sourceDepositor: bytes32(params.depositor),
    destinationRecipient: bytes32(params.recipient),
    sourceSigner: bytes32(params.depositor),
    destinationCaller: bytes32(zeroAddress),
    value: params.available,
    salt: params.salt,
    hookData: "0x" as Hex,
  };
  const estimate = (await gatewayFetch(`${config.apiUrl}/estimate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([{ spec }], jsonSafe),
  })) as { burnIntent?: { maxBlockHeight?: string; maxFee?: string } }[];
  const quoted = estimate[0]?.burnIntent;
  if (quoted?.maxFee === undefined || quoted.maxBlockHeight === undefined) {
    throw new GatewayError("Gateway's estimate has no fee");
  }
  const maxFee = BigInt(quoted.maxFee);
  if (params.available <= maxFee) return null;
  return {
    maxBlockHeight: BigInt(quoted.maxBlockHeight),
    maxFee,
    spec: { ...spec, value: params.available - maxFee },
  };
}

/** The EIP-712 message the depositor signs for a burn intent (Circle's domain has no chain id). */
export function burnIntentTypedData(intent: BurnIntent) {
  return {
    domain: { name: "GatewayWallet", version: "1" },
    types: {
      TransferSpec: [
        { name: "version", type: "uint32" },
        { name: "sourceDomain", type: "uint32" },
        { name: "destinationDomain", type: "uint32" },
        { name: "sourceContract", type: "bytes32" },
        { name: "destinationContract", type: "bytes32" },
        { name: "sourceToken", type: "bytes32" },
        { name: "destinationToken", type: "bytes32" },
        { name: "sourceDepositor", type: "bytes32" },
        { name: "destinationRecipient", type: "bytes32" },
        { name: "sourceSigner", type: "bytes32" },
        { name: "destinationCaller", type: "bytes32" },
        { name: "value", type: "uint256" },
        { name: "salt", type: "bytes32" },
        { name: "hookData", type: "bytes" },
      ],
      BurnIntent: [
        { name: "maxBlockHeight", type: "uint256" },
        { name: "maxFee", type: "uint256" },
        { name: "spec", type: "TransferSpec" },
      ],
    },
    primaryType: "BurnIntent" as const,
    message: intent,
  };
}

export interface GatewayAttestation {
  readonly transferId: string;
  readonly attestation: Hex;
  readonly signature: Hex;
  /** What Circle charged, in micro-USDC. */
  readonly fee: bigint;
}

/** Circle refused a burn intent because it already attested it (sent twice). */
export class BurnIntentUsedError extends GatewayError {}

/** Sends a signed burn intent to Circle for attestation. */
export async function submitBurnIntent(
  network: string,
  intent: BurnIntent,
  signature: Hex,
): Promise<GatewayAttestation> {
  const config = networkOf(network);
  let data: Record<string, unknown>;
  try {
    data = (await gatewayFetch(`${config.apiUrl}/transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ burnIntent: intent, signature }], jsonSafe),
    })) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GatewayError && /already been used/i.test(error.message)) {
      throw new BurnIntentUsedError(error.message);
    }
    throw error;
  }
  if (typeof data.attestation !== "string" || typeof data.signature !== "string") {
    throw new GatewayError("Gateway returned no attestation");
  }
  const fees = data.fees as { total?: string } | undefined;
  return {
    transferId: String(data.transferId),
    attestation: data.attestation as Hex,
    signature: data.signature as Hex,
    fee: typeof fees?.total === "string" ? toMicros(fees.total) : intent.maxFee,
  };
}

/** A withdrawal's status at Circle: "finalized" once the mint landed, with its transaction. */
export async function gatewayTransferStatus(
  network: string,
  transferId: string,
): Promise<{ readonly status: string; readonly transactionHash: string | null }> {
  const config = networkOf(network);
  const data = (await gatewayFetch(`${config.apiUrl}/transfer/${encodeURIComponent(transferId)}`, {
    method: "GET",
  })) as { status?: unknown; transactionHash?: unknown };
  return {
    status: String(data.status ?? "unknown"),
    transactionHash: typeof data.transactionHash === "string" ? data.transactionHash : null,
  };
}

export const gatewayMinterAbi = parseAbi([
  "function gatewayMint(bytes attestationPayload, bytes signature)",
]);
