/**
 * Dev helper standing in for a paying customer: pays USDC into a job's vault (approve + fund)
 * from DEV_CUSTOMER_PRIVATE_KEY. The indexer records it as revenue because it doesn't come from
 * the owner.
 *
 *   pnpm --filter @bursar/worker onchain:pay <vaultJobId> <amountUsdc>
 */
import { fileURLToPath } from "node:url";
import { parseUsdc } from "@bursar/money";
import { jobVaultAbi, usdcAbi } from "@bursar/payments";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
const [vaultJobId, amountText] = process.argv.slice(2);
const key = process.env.DEV_CUSTOMER_PRIVATE_KEY;
if (vaultJobId === undefined || amountText === undefined || key === undefined) {
  process.stderr.write(
    "Usage: onchain:pay <vaultJobId> <amountUsdc>  (needs DEV_CUSTOMER_PRIVATE_KEY)\n",
  );
  process.exit(1);
}
const amount = parseUsdc(amountText);
const transport = http(process.env.ARC_RPC_URL, { retryCount: 3 });
const client = createPublicClient({ chain: arcTestnet, transport });
const customer = createWalletClient({
  chain: arcTestnet,
  transport,
  account: privateKeyToAccount(key as Hex),
});
const vault = process.env.JOB_VAULT_ADDRESS as Hex;

for (const [label, tx] of [
  [
    "approve",
    () =>
      customer.writeContract({
        address: process.env.USDC_ADDRESS as Hex,
        abi: usdcAbi,
        functionName: "approve",
        args: [vault, amount],
      }),
  ],
  [
    "fund",
    () =>
      customer.writeContract({
        address: vault,
        abi: jobVaultAbi,
        functionName: "fund",
        args: [vaultJobId as Hex, amount],
      }),
  ],
] as const) {
  const hash = await tx();
  const receipt = await client.waitForTransactionReceipt({ hash });
  process.stdout.write(`${label}: ${receipt.status} ${hash}\n`);
}
