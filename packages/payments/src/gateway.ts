import type { PaymentRequirements } from "@x402/core/types";
import { encodeFunctionData, parseAbi, type Hex } from "viem";

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
  /** Circle's Gateway domain id for the chain (used by the balances API). */
  readonly domain: number;
  readonly apiUrl: string;
}

/** Networks Bursar can pay through Gateway, by CAIP-2 id (checked against Circle's API). */
export const GATEWAY_NETWORKS: Record<string, GatewayNetwork> = {
  "eip155:5042002": {
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    domain: 26,
    apiUrl: "https://gateway-api-testnet.circle.com/v1",
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
