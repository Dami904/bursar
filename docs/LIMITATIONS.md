# Limitations

What Bursar does **not** do yet, stated plainly. Updated as the build progresses.

## Current (day 10)

- **The demo job is public on purpose.** `/demo` shows one job, set by `DEMO_JOB_ID`, to anyone: its decisions, the agents' reasoning, payees and evidence. It's our own business's job. The public API serves no other job's data (tested).
- **The demo's approvals are automatic.** A demo approver (a key the server holds, allowed only on the demo job in the vault) signs the demo job's payments after a minute, so the public feed shows approvals without a person on call. Real jobs are never approved this way.
- **The demo's story repeats.** Its brief rotates through five scenes every few hours; the operator gets a summary of earlier runs so it doesn't buy the same thing twice in a row.

## Day 9

- **Automatic runs depend on the model being available.** If Gemini is overloaded when a run starts, Bursar tries the fallback model, then retries the run with backoff (2 minutes, doubling to 30, five tries). A job whose runs keep failing waits for the owner's "Run now".
- **One automatic run at a time**, across all jobs, to stay within free-tier model limits. A busy deployment would need a queue per model key.
- **Alerts go out once per event.** An alert queued while an owner had no targets isn't re-sent after they add one. Delivery gives up after 8 attempts.
- **Wallet sign-in accepts ordinary wallets only** (EOAs), like approvals. Smart-contract wallets can't sign in yet.
- **Replacing an agent from the console reuses its name**; there's no rename yet.
- **A job can be closed only when nothing is held, waiting or stuck.** Pending approvals must be approved or rejected first, and stuck payments must resolve (refunded or settled).

## Day 8

- **The audit log starts at day 8.** Decisions made earlier were added once, in order, when the worker first started with the log. Their earlier state changes (reserved, paid, refunded) aren't in it.
- **Only anchored history is fixed.** The worker anchors the log's head on Arc every 10 minutes, or after 50 new entries. Until the next anchor, someone with database access could rewrite the newest entries unnoticed. Anything already anchored can't be changed without verification failing.
- **The audit log is one chain for the whole deployment.** An owner sees payloads only for their own jobs. Verifying the whole chain reports only pass/fail and the head, so no other business's data is revealed.
- **Vendors must be allow-listed twice for invoices:** in Bursar, and in the vault from the owner's wallet (the console's "Allow in vault" button, or `onchain:payee`). An invoice is a reference number and an amount; no invoice file is stored.
- **A replaced agent's refunds don't pass to its replacement.** If one of the old agent's payments is refunded later, that headroom goes back to the old (revoked) agent, not the new one. This errs on the side of spending less.
- **Sibling helpers' limits can add up to more than their parent's.** Each helper's limit must fit what its parents have left when it's created. Every payment is also checked against every limit above it, so together they can never spend more than the parent's limit.

- **The operator's judgement is only as good as its model.** In the [model eval](evals/operator-models.md), both Gemini Flash-Lite models resisted prompt injection every time but mostly followed a misleading brief into a pointless one-cent purchase (3.1: 0/3, 3.5: 1/3). Bursar's limits capped the cost, but didn't make the choice wise. Claude is supported for harder jobs.
- **Free-tier Gemini allows about 1,000 model calls a day** (500 on 3.1 Flash-Lite plus 500 on the 3.5 Flash-Lite fallback), roughly 200 operator runs. A run that starts when both quotas are used up fails with the quota error and spends nothing.
- **Sellers without a catalog** (`/.well-known/x402`) are still allowed, but the agent can only buy from them if the brief names the URL.
- **The Claude provider hasn't run live yet** (no Anthropic key at the time); it's unit-tested through the same interface as Gemini, which has.
- **AI cost uses paid-tier prices.** On Gemini's free tier the real cost is zero; Bursar records the paid-tier figure so profit is never overstated.
- **Revenue is any deposit not from the owner's wallet.** There's no invoice or customer record behind it yet.

## Carried over

- **Refunds wait for the signed payment to expire.** A refused or silent payment is refunded only after its signature expires by chain time (the seller's `maxTimeoutSeconds`, often a few minutes), because until then it could still be settled. The money stays counted against the budget meanwhile.
- **Refund gas comes from the operator.** Arc gas is USDC from the same balance, so the operator tops up 0.01 USDC before a job wallet sends money back. The sweeper returns leftovers of at least 0.01 USDC from idle job wallets to the operator (keeping 0.005 for the transfer fee); smaller dust stays, because the fee would eat most of it.
- **A frozen job must be resumed by hand.** When the vault pays out money Bursar can't match to a payment, the job is frozen in Bursar and paused on-chain. The owner checks what happened, then presses "unfreeze" in the console, which clears it in Bursar and resumes the job on-chain from their wallet.
- **Approvals are verified server-side for regular wallets only.** The API checks the approver's EIP-712 signature with `verifyTypedData`, which covers ordinary (EOA) wallets. JobVault itself also accepts smart-contract wallets (ERC-1271), but the API would reject such an approver today.
- Adding another approver (someone other than the owner) still takes the API plus `onchain:approver`; the console sets up only the owner's own wallet as approver. `dev:approve` remains for scripted tests.
- The SSRF check resolves a seller's hostname before fetching, but the fetch resolves it again (a DNS-rebinding window). The allow-list is checked first, so only owner-approved origins are ever fetched.
- No rate limiting on the API yet.
- The x402 seller runs on Circle's keyless trial, which has a per-address allowance.

## By design (for the hackathon)

- Agents are not on-chain identities. Per-agent rules (revoking one agent, sub-limits, categories) are enforced by the Bursar API; the contract enforces the job-level envelope (budget, deposits, caps, payees, rate window, approvals).
- Contracts are immutable, and the operator address is fixed at deployment. Rotating a leaked operator key means deploying a new vault and moving jobs to it (owners pause and close old jobs to get their USDC back).
- Refund accounting trusts the operator to name the right operation: `refund` checks the USDC really arrived and never credits more than the operation released, but can't tell which failed payment the returned money came from.
- Arc and USDC only. No other chains or tokens.
