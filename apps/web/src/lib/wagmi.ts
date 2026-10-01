import { arc, arcTestnet } from "viem/chains";
import { createConfig, http } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { config } from "./config.js";

/**
 * Browser wallets (MetaMask, Rabby, Coinbase…) on desktop; WalletConnect for phone wallets, which
 * matters because approvals are meant to happen on a phone.
 */
export const wagmiConfig = createConfig({
  chains: [config.chain],
  connectors: [
    injected(),
    ...(config.walletConnectProjectId
      ? [
          walletConnect({
            projectId: config.walletConnectProjectId,
            metadata: {
              name: "Bursar",
              description: "Job budgets for AI agent teams",
              url: window.location.origin,
              icons: [`${window.location.origin}/favicon.svg`],
            },
          }),
        ]
      : []),
  ],
  // One chain per build (see config.ts); both are listed so either build type-checks.
  transports: { [arc.id]: http(), [arcTestnet.id]: http() },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
