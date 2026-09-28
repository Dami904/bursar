/**
 * Probe: can a developer-controlled wallet on Arc testnet sign EIP-712 typed data (what x402's
 * EIP-3009 authorization needs)? Creates one EOA wallet in Bursar's wallet set, signs a harmless
 * typed message, and checks the signature recovers to the wallet's address. Moves no money.
 *
 *   pnpm --filter @bursar/worker circle:probe
 */
import { fileURLToPath } from "node:url";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { recoverTypedDataAddress, type Hex } from "viem";

process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
const client = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY ?? "",
  entitySecret: process.env.CIRCLE_ENTITY_SECRET ?? "",
});
const walletSetId = process.env.CIRCLE_WALLET_SET_ID ?? "";

const created = await client.createWallets({
  walletSetId,
  blockchains: ["ARC-TESTNET"],
  count: 1,
  accountType: "EOA",
  metadata: [{ name: "bursar-probe" }],
});
const wallet = created.data?.wallets?.[0];
if (wallet === undefined) throw new Error("no wallet returned");
process.stdout.write(`Wallet: ${wallet.address} (${wallet.blockchain}, ${wallet.accountType})\n`);

const typedData = {
  domain: { name: "Bursar probe", version: "1", chainId: 5042002 },
  types: {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
    ],
    Probe: [{ name: "message", type: "string" }],
  },
  primaryType: "Probe",
  message: { message: "hello from Bursar" },
} as const;

const signed = await client.signTypedData({
  walletId: wallet.id,
  data: JSON.stringify(typedData),
});
const signature = signed.data?.signature as Hex | undefined;
if (signature === undefined) throw new Error("no signature returned");
const recovered = await recoverTypedDataAddress({
  domain: typedData.domain,
  types: { Probe: typedData.types.Probe },
  primaryType: "Probe",
  message: typedData.message,
  signature,
});
const ok = recovered.toLowerCase() === wallet.address.toLowerCase();
process.stdout.write(
  `Typed-data signature recovers to the wallet: ${ok ? "YES" : `NO (${recovered})`}\n`,
);
