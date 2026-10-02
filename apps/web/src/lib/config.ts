import { arc, arcTestnet } from "viem/chains";

const env = import.meta.env as Record<string, string | undefined>;

/** Arc mainnet (real USDC) only when the build says so: every other build is testnet. */
const mainnet = env.VITE_ARC_CHAIN_ID === String(arc.id);

/** The vault the console talks to. Testnet has a default; mainnet must name its own. */
function vaultAddress(): `0x${string}` {
  const configured = env.VITE_JOB_VAULT_ADDRESS as `0x${string}` | undefined;
  if (configured !== undefined) return configured;
  if (mainnet) throw new Error("VITE_JOB_VAULT_ADDRESS is required for an Arc mainnet build");
  return "0x5Cd51a31fE931D31574Eadd083A0B5c210CA2cB6";
}

/** Everything the console needs to know about where it runs. Only VITE_* values reach the browser. */
export const config = {
  apiUrl: env.VITE_API_URL ?? "http://127.0.0.1:8787",
  /** True on the mainnet console: payments there move real USDC. */
  mainnet,
  chain: mainnet ? arc : arcTestnet,
  vault: vaultAddress(),
  usdc:
    (env.VITE_USDC_ADDRESS as `0x${string}` | undefined) ??
    "0x3600000000000000000000000000000000000000",
  walletConnectProjectId: env.VITE_WALLETCONNECT_PROJECT_ID,
  explorer: mainnet ? "https://explorer.arc.io" : "https://explorer.testnet.arc.io",
  /**
   * The same console on the other network (testnet links to mainnet and back), e.g.
   * https://bursarhq-mainnet.vercel.app. No link until it's set, so it never points at nothing.
   */
  otherNetworkUrl: env.VITE_OTHER_NETWORK_URL,
};

export const txUrl = (hash: string) => `${config.explorer}/tx/${hash}`;
export const addressUrl = (address: string) => `${config.explorer}/address/${address}`;
