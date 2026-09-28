/**
 * Exports the policy vectors as a flat fixture the Foundry tests replay against JobVault, so the
 * off-chain policy engine and the on-chain contract can't silently disagree.
 *
 * Checks that only exist off-chain (agent identity, agent sub-limits, category budgets) are left
 * out: on-chain, agents aren't identities and categories don't exist.
 *
 *   pnpm --filter @bursar/policy export:parity
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inputFor, vectors } from "./vectors.js";

export const fixturePath = fileURLToPath(
  new URL("../../../contracts/test/fixtures/policy-parity.json", import.meta.url),
);

const offChainOnly = new Set([
  "AGENT_NOT_IN_JOB",
  "AGENT_REVOKED",
  "AGENT_LIMIT_EXCEEDED",
  "CATEGORY_BUDGET_EXCEEDED",
]);

export function buildParityFixture(): string {
  const cases = vectors
    .filter((v) => v.expect.reason === undefined || !offChainOnly.has(v.expect.reason))
    .map((v) => {
      const input = inputFor(v);
      const { job } = input;
      const now = input.now.getTime();
      return {
        name: v.name,
        status: job.status,
        expired: now >= job.expiresAt.getTime(),
        budget: Number(job.budget),
        deposited: Number(job.deposited),
        spent: Number(job.committed),
        perTxCap: Number(job.perTxCap),
        approvalThreshold: Number(job.approvalThreshold),
        windowCap: Number(job.windowCap),
        windowSeconds: job.windowSeconds,
        windowAge: Math.round((now - job.windowStart.getTime()) / 1000),
        windowSpent: Number(job.windowSpent),
        payeeAllowed: input.payee !== null,
        amount: Number(input.request.amount),
        expect: v.expect.outcome === "DENIED" ? v.expect.reason : v.expect.outcome,
      };
    });
  return `${JSON.stringify({ generatedFrom: "packages/policy/vectors/policy-vectors.json", count: cases.length, cases }, null, 2)}\n`;
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  writeFileSync(fixturePath, buildParityFixture());
  process.stdout.write(`Wrote ${fixturePath}\n`);
}
