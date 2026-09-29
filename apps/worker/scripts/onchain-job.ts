/**
 * Dev helper standing in for the owner's browser wallet: creates and funds a Bursar job in
 * JobVault. The owner key is the arc-canteen dev wallet, read from ~/.arc-canteen/wallet.yaml at
 * run time and never written anywhere else.
 *
 *   pnpm --filter @bursar/worker onchain:job <vaultJobId> <agentWallet> <budget> <perTxCap> <threshold> <windowCap> <fund> [expiryUnixSeconds]
 *   (amounts in USDC, e.g. 0.50)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUsdc } from "@bursar/money";
import { jobVaultAbi, usdcAbi } from "@bursar/payments";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
const [vaultJobId, agentWallet, budget, perTxCap, threshold, windowCap, fund, expiryArg] =
  process.argv.slice(2);
if (
  vaultJobId === undefined ||
  agentWallet === undefined ||
  budget === undefined ||
  perTxCap === undefined ||
  threshold === undefined ||
  windowCap === undefined ||
  fund === undefined
) {
  process.stderr.write(
    "Usage: onchain:job <vaultJobId> <agentWallet> <budget> <perTxCap> <threshold> <windowCap> <fund>\n",
  );
  process.exit(1);
}

const walletFile = readFileSync(join(homedir(), ".arc-canteen", "wallet.yaml"), "utf8");
const ownerKey = /0x[0-9a-fA-F]{64}/.exec(walletFile)?.[0];
if (ownerKey === undefined) throw new Error("No private key in ~/.arc-canteen/wallet.yaml");

const transport = http(process.env.ARC_RPC_URL, { retryCount: 3 });
const client = createPublicClient({ chain: arcTestnet, transport });
const owner = createWalletClient({
  chain: arcTestnet,
  transport,
  account: privateKeyToAccount(ownerKey as Hex),
});
const vault = process.env.JOB_VAULT_ADDRESS as Hex;
const usdc = process.env.USDC_ADDRESS as Hex;

async function send(label: string, tx: Promise<Hex>) {
  const hash = await tx;
  const receipt = await client.waitForTransactionReceipt({ hash });
  process.stdout.write(`${label}: ${receipt.status} ${hash}\n`);
  if (receipt.status !== "success") process.exit(1);
}

await send(
  "createJob",
  owner.writeContract({
    address: vault,
    abi: jobVaultAbi,
    functionName: "createJob",
    args: [
      vaultJobId as Hex,
      {
        agentWallet: agentWallet as Hex,
        budget: parseUsdc(budget),
        perTxCap: parseUsdc(perTxCap),
        approvalThreshold: parseUsdc(threshold),
        windowCap: parseUsdc(windowCap),
        window: 3600n,
        // Match the job's expiresAt in Bursar when given; otherwise a week.
        expiry: BigInt(expiryArg ?? Math.floor(Date.now() / 1000) + 7 * 86400),
      },
    ],
  }),
);
await send(
  "approve",
  owner.writeContract({
    address: usdc,
    abi: usdcAbi,
    functionName: "approve",
    args: [vault, parseUsdc(fund)],
  }),
);
await send(
  "fund",
  owner.writeContract({
    address: vault,
    abi: jobVaultAbi,
    functionName: "fund",
    args: [vaultJobId as Hex, parseUsdc(fund)],
  }),
);
