# Threat model

Draft from `PLAN.md` §7 and §8.1.6. Checked against the code as each part is built.

## Who is trusted with what

| Party                | Holds                                  | Trusted to                                                           |
| -------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| Owner (the business) | Owner wallet                           | Set budgets, caps, payees and approvers; pause and unpause; withdraw |
| Approver             | Approver wallet                        | Sign approvals for payments above the threshold                      |
| Agent                | One scoped agent key                   | Request spends for its own job only                                  |
| Bursar server        | Operator key; Circle wallet API access | Run policy and call `release` within the contract's limits           |

## If a key is compromised

| Compromised                  | Worst case                                                                                                                        | What bounds it                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| One agent key                | Spends up to its job's remaining budget (and its own and its parents' limits), to allowed payees, within the per-tx cap           | API policy + JobVault; the owner revokes or replaces it in one tap  |
| A console session (browser)  | Acts as the owner in the API for up to 24 hours: can change payees and create agent keys, but can't sign on-chain                 | On-chain changes still need the owner's wallet; sign out revokes it |
| Bursar server + operator key | Per job: releases up to the remaining budget, only to allowed payees or the job's agent wallet, within the per-tx and hourly caps | JobVault rules only the owner can change; owner can pause instantly |
| Circle wallet access         | Spends what's in the agent wallet: only payments in flight                                                                        | Just-in-time top-ups; wallet's own spending policy                  |
| Owner wallet                 | Everything for that owner's jobs                                                                                                  | Nothing. The owner is the root of trust.                            |

## Not defended (be explicit)

- A compromised server can still drain each job's remaining budget to its allow-listed payees, at the hourly cap rate, until the owner pauses.
- A malicious or compromised allow-listed payee is paid if the agent chooses it. Bursar limits who can be paid, not whether they deliver.
- A bad decision by the AI operator within policy (overpaying an allowed seller) is recorded and explainable, not prevented.
- Denial of service against the API or RPC stops new payments; it does not move money.
- The operator address is fixed in the deployed contracts. A leaked operator key can't be rotated in place; owners pause and close their jobs and a new vault is deployed.

## Enforced on-chain (JobVault, tested)

- Default deny: a payee or approver that was never allowed is refused (`isPayee` / `isApprover` default to false).
- The contract recomputes every check itself; nothing the operator claims is trusted.
- Only the job owner can change rules; the operator can release inside them and pause, never unpause.
- Every effective rule change bumps `policyVersion`. Releases decided under an older version revert `StalePolicy`; approvals are signed over the version, so a rule change voids them.
- Approvals are EIP-712, bound to this contract and chain, to one operation ID, payee and amount, and expire by chain time. A used operation ID can never release again, even after a refund.
- The vault's USDC balance always covers what it owes (fuzzed invariant); refunds only credit USDC that has actually arrived.

## Console and sign-in

- Sign-in is Sign-In with Ethereum: one-time nonces (10 minutes), checked against our domains and chain, EOA signatures only. Sessions last 24 hours and are revoked on sign-out.
- The session key sits in `localStorage` and is only ever sent in an `Authorization` header to the API (no cookies), so a cross-site request can't use it. An XSS bug would expose it; React escapes all rendered text and the console renders no HTML from the API.
- CORS allows only the configured console origins.
- The audit log is recomputed in the browser ("Verify"), so an owner doesn't have to trust the server's own "verified" answer.

## The public demo

- `/demo` and `/demo/decisions/:id` need no key and serve exactly one job (`DEMO_JOB_ID`); a decision from any other job returns 404 (tested).
- The demo approver's key and wallet sit on the server, but the wallet is an approver only on the demo job in the vault, so it can't approve anything else even if leaked.

## Alerts and automatic runs

- Webhook URLs are the owner's own, but the worker fetches them, so they go through the same SSRF guard as sellers (no private addresses, checked again when the connection is made, no redirects, 5-second timeout). Every POST carries an HMAC-SHA256 signature over the timestamp and body.
- Telegram links are one-time codes valid for an hour; the bot token never appears in errors or logs.
- Each automatic operator run gets a fresh agent key that is revoked when the run ends. Revoking the job's "Operator (auto)" agent stops automatic runs.

## Detected off-chain (worker, tested)

- **Unexplained payouts.** Every `Released` event must match one of the job's payments (operation ids are derived, so even an unrecorded Bursar release matches). A payout with no match freezes the job in Bursar at once and the reconciler pauses it on-chain. This is what catches a leaked operator key being used outside Bursar; it bounds the loss to what was released before the indexer saw it (seconds on Arc).

## Known weaknesses worth attacking first

1. The boundary between the database reservation and the on-chain `release` (crash and retry paths).
2. Operator key nonce handling under concurrent releases.
3. Prompt injection through paid-service responses reaching the operator's tools.
4. SSRF through the `quote` step (addresses are checked before the request and again when the connection is made, with IPv4-in-IPv6, NAT64 and other internal ranges blocked).
5. A compromised operator can call `refund` for the wrong operation (it can't create money, but it can mis-attribute returned USDC between a job's operations).
6. XSS in the console (it would expose the 24-hour session key).
7. DNS rebinding for webhooks and sellers: the connection itself refuses internal addresses, so a name that changes its answer after the check still can't reach one. Worth attacking anyway.
