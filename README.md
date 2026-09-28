# Bursar

**Give an AI team a job and a budget, not the company wallet.**

Bursar holds each job's USDC on [Arc](https://docs.arc.network) in a contract that enforces the budget. An AI operator decides what to spend it on, and every payment carries a reason, a policy decision and an Arc transaction. Agents can't raise their own budget or pretend to be another agent, and even if Bursar's server is compromised, the damage is capped by on-chain rules only the owner can change.

Built for the [Tameion Agents Hackathon](https://tameion.thecanteenapp.com/) (Canteen × Circle), RFB 04 · Autonomous Business Operator.

> Status: **day 9 of 14.** A web console (wallet sign-in, live job page, phone approvals, evidence you can verify in the browser, alerts) over an AI operator that runs jobs on Arc testnet by itself: customer revenue in, budget check, purchase or invoice decision, human approval, payment, and a hash-chained record of every reason and cost, anchored on Arc ([day 5](docs/spikes/day-5-live-purchase.md), [day 6](docs/spikes/day-6-refund-and-approval.md), [day 7](docs/spikes/day-7-ai-operator.md), [model eval](docs/evals/operator-models.md), [day 8](docs/spikes/day-8-delegation-invoices-audit.md), [day 9](docs/spikes/day-9-console.md)). See [`PLAN.md`](PLAN.md) for the rest.

## Repository

| Path                                     | What it is                                                                                   | Status                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`packages/money`](packages/money)       | Integer micro-USDC: parsing, formatting, Arc 6↔18-decimal conversion                         | Done, tested                                                                         |
| [`packages/policy`](packages/policy)     | Pure spend policy (fixed-order checks) and authorization states, with shared test vectors    | Done, tested                                                                         |
| [`packages/db`](packages/db)             | Shared schema, migrations and ledger transitions                                             | Done                                                                                 |
| [`packages/payments`](packages/payments) | x402 quote/sign/pay, SSRF guard, Circle wallets, chain helpers                               | Done, tested                                                                         |
| [`contracts`](contracts)                 | `JobVault` and `AuditAnchor` (Solidity, Foundry)                                             | Deployed + verified on Arc testnet; 48 tests, 100% line coverage, 0 slither findings |
| [`apps/api`](apps/api)                   | HTTP API: scoped keys, policy, atomic reservations, x402 purchases, approvals                | Working, tested against Postgres                                                     |
| [`apps/worker`](apps/worker)             | Indexer, purchase executor, reconciler (refunds, approval expiry, stuck-release replacement) | Working live; 10 tests on a local Anvil chain                                        |
| [`apps/operator`](apps/operator)         | AI operator: tool-use loop on Gemini 3.1 Flash-Lite or Claude, spends only through Bursar    | Working live (Gemini); 7 tests                                                       |
| [`apps/mcp`](apps/mcp)                   | MCP server for other people's agents                                                         | Planned                                                                              |
| [`apps/seller`](apps/seller)             | Our x402 paid service, settled by Circle's Facilitator on Arc testnet                        | Working ([day-2 proof](docs/spikes/day-2-payments.md))                               |
| [`apps/web`](apps/web)                   | Landing page, public demo, operator console                                                  | Planned                                                                              |

## Run it locally

Requires Node 24, pnpm 11, Docker and Foundry.

```sh
git clone --recurse-submodules <repo-url>
pnpm install
cp .env.example .env
docker compose up -d   # Postgres on 127.0.0.1:54330 (bursar + bursar_test)
pnpm test              # no API keys, wallets or network needed
pnpm lint && pnpm typecheck && pnpm build
cd contracts && forge test
```

## Docs

- [`PLAN.md`](PLAN.md): the full build plan
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md): who is trusted and what isn't defended
- [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md): what doesn't work yet

## License

[MIT](LICENSE)
