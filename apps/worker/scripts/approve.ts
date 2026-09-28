/**
 * Dev helper standing in for a human approver in the console: fetches the oldest pending
 * approval, signs exactly the EIP-712 message the API returns with DEV_APPROVER_PRIVATE_KEY, and
 * submits it. Never prints keys.
 *
 *   BURSAR_APPROVER_KEY=bsr_apr_... pnpm --filter @bursar/worker dev:approve [apiUrl]
 */
import { fileURLToPath } from "node:url";
import type { Hex, TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";

process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
const api = process.argv[2] ?? "http://127.0.0.1:8787";
const bursarKey = process.env.BURSAR_APPROVER_KEY;
const walletKey = process.env.DEV_APPROVER_PRIVATE_KEY;
if (bursarKey === undefined || walletKey === undefined) {
  throw new Error(
    "Set BURSAR_APPROVER_KEY (Bursar approver key) and DEV_APPROVER_PRIVATE_KEY in .env",
  );
}
const wallet = privateKeyToAccount(walletKey as Hex);
const headers = { authorization: `Bearer ${bursarKey}`, "content-type": "application/json" };

const listing = (await (await fetch(`${api}/approvals`, { headers })).json()) as {
  pending: {
    authorizationId: string;
    amount: string;
    reasoning: string;
    typedData: TypedDataDefinition & { message: { deadline: string; policyVersion: string } };
  }[];
};
const item = listing.pending.at(-1);
if (item === undefined) {
  process.stdout.write("Nothing waiting for approval.\n");
  process.exit(0);
}
process.stdout.write(`Approving ${item.amount} USDC: "${item.reasoning}"\n`);
const signature = await wallet.signTypedData(item.typedData);
const response = await fetch(`${api}/approvals/${item.authorizationId}`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    verdict: "APPROVE",
    approverAddress: wallet.address,
    signature,
    deadline: Number(item.typedData.message.deadline),
    policyVersion: Number(item.typedData.message.policyVersion),
  }),
});
process.stdout.write(`${response.status} ${await response.text()}\n`);
