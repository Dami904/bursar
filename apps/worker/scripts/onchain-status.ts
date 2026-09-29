/**
 * Dev helper standing in for the owner's browser wallet: pauses, resumes or closes a vault job (close returns unspent USDC to the owner).
 * The owner key is the arc-canteen dev wallet (~/.arc-canteen/wallet.yaml), read at run time only.
 *
 *   pnpm --filter @bursar/worker onchain:status <vaultJobId> <pause|unpause|close>
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jobVaultAbi } from "@bursar/payments";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
const [vaultJobId, action] = process.argv.slice(2);
if (
  vaultJobId === undefined ||
  action === undefined ||
  !["pause", "unpause", "close"].includes(action)
) {
  process.stderr.write("Usage: onchain:status <vaultJobId> <pause|unpause|close>\n");
  process.exit(1);
}
const ownerKey = /0x[0-9a-fA-F]{64}/.exec(
  readFileSync(join(homedir(), ".arc-canteen", "wallet.yaml"), "utf8"),
)?.[0];
if (ownerKey === undefined) throw new Error("No private key in ~/.arc-canteen/wallet.yaml");

const transport = http(process.env.ARC_RPC_URL, { retryCount: 3 });
const client = createPublicClient({ chain: arcTestnet, transport });
const owner = createWalletClient({
  chain: arcTestnet,
  transport,
  account: privateKeyToAccount(ownerKey as Hex),
});
const hash = await owner.writeContract({
  address: process.env.JOB_VAULT_ADDRESS as Hex,
  abi: jobVaultAbi,
  functionName: action === "close" ? "closeJob" : (action as "pause" | "unpause"),
  args: [vaultJobId as Hex],
});
const receipt = await client.waitForTransactionReceipt({ hash });
process.stdout.write(`${action}: ${receipt.status} ${hash}\n`);
