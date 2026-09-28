import { arcTestnet } from "viem/chains";

/** Everything the console needs to know about where it runs. Only VITE_* values reach the browser. */
export const config = {
  apiUrl: (import.meta.env.VITE_API_URL as string | undefined) ?? "http://127.0.0.1:8787",
  chain: arcTestnet,
  vault:
    (import.meta.env.VITE_JOB_VAULT_ADDRESS as `0x${string}` | undefined) ??
    "0x5Cd51a31fE931D31574Eadd083A0B5c210CA2cB6",
  usdc:
    (import.meta.env.VITE_USDC_ADDRESS as `0x${string}` | undefined) ??
    "0x3600000000000000000000000000000000000000",
  walletConnectProjectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined,
  explorer: "https://explorer.testnet.arc.io",
};

export const txUrl = (hash: string) => `${config.explorer}/tx/${hash}`;
export const addressUrl = (address: string) => `${config.explorer}/address/${address}`;
