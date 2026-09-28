/**
 * Verifies the Circle API key + entity secret pair and makes sure Bursar's wallet set exists.
 * Creating a wallet set requires a valid entity secret, so success proves the pair works.
 * Idempotent: re-running finds the existing set instead of creating another.
 *
 *   pnpm --filter @bursar/worker circle:setup
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
process.loadEnvFile(envPath);
const apiKey = process.env.CIRCLE_API_KEY ?? "";
const entitySecret = process.env.CIRCLE_ENTITY_SECRET ?? "";
if (apiKey === "" || entitySecret === "")
  throw new Error("CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET must be set");

const WALLET_SET_NAME = "bursar-testnet";
const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

const existing = (await client.listWalletSets({})).data?.walletSets ?? [];
let walletSet = existing.find((s) => "name" in s && s.name === WALLET_SET_NAME);
if (walletSet === undefined) {
  walletSet = (await client.createWalletSet({ name: WALLET_SET_NAME })).data?.walletSet;
  process.stdout.write(`Created wallet set "${WALLET_SET_NAME}" (entity secret verified).\n`);
} else {
  process.stdout.write(`Wallet set "${WALLET_SET_NAME}" already exists.\n`);
}
if (walletSet?.id === undefined) throw new Error("No wallet set id returned");

const env = readFileSync(envPath, "utf8");
const line = `CIRCLE_WALLET_SET_ID=${walletSet.id}`;
writeFileSync(
  envPath,
  /^CIRCLE_WALLET_SET_ID=.*$/m.test(env)
    ? env.replace(/^CIRCLE_WALLET_SET_ID=.*$/m, line)
    : `${env.trimEnd()}\n${line}\n`,
);
process.stdout.write(`CIRCLE_WALLET_SET_ID=${walletSet.id} saved to .env\n`);
