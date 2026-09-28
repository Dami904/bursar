/**
 * Dev helper standing in for the owner's browser wallet: allows an approver wallet on a vault job.
 * The owner key is the arc-canteen dev wallet (~/.arc-canteen/wallet.yaml), read at run time only.
 *
 *   pnpm --filter @bursar/worker onchain:approver <vaultJobId> <approverAddress>
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
const [vaultJobId, approver] = process.argv.slice(2);
if (vaultJobId === undefined || approver === undefined) {
  process.stderr.write("Usage: onchain:approver <vaultJobId> <approverAddress>\n");
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
  functionName: "setApprover",
  args: [vaultJobId as Hex, approver as Hex, true],
});
const receipt = await client.waitForTransactionReceipt({ hash });
process.stdout.write(`setApprover: ${receipt.status} ${hash}\n`);
