# Arc mainnet checklist

Bursar runs on Arc testnet today. This is everything needed for a **separate** mainnet deployment
that holds real USDC, while the testnet demo and the hackathon links keep working.

Nothing here has been done yet. Steps marked **(you)** move real money, create accounts or handle
keys, so they're yours to do.

## Facts, checked on 2026-10-01

|                      | Arc mainnet                                  | Arc testnet (today)                          |
| -------------------- | -------------------------------------------- | -------------------------------------------- |
| Chain id             | 5042                                         | 5042002                                      |
| RPC                  | `https://rpc.mainnet.arc.io`                 | `https://rpc.testnet.arc.io`                 |
| Explorer             | `https://explorer.arc.io`                    | `https://explorer.testnet.arc.io`            |
| USDC                 | `0x3600000000000000000000000000000000000000` | same                                         |
| Gateway wallet       | `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| Gateway minter       | `0x2222222d7164433c4C09B0b0D809a9b52C04C205` | `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B` |
| Gateway domain       | 26                                           | 26                                           |
| Gateway API          | `https://gateway-api.circle.com/v1`          | `https://gateway-api-testnet.circle.com/v1`  |
| Circle wallets chain | `ARC`                                        | `ARC-TESTNET`                                |

Proven: Bursar's x402 client paid a real mainnet seller (Exa, $0.001, POST) on 2026-10-01:
[`0xab8350…88af2`](https://explorer.arc.io/tx/0xab8350e9733ff8800e286b689d17415394054eac86e89397eea5917637688af2).

## Decisions first (you)

- [x] **Budget cap: 5 USDC per job** (`MAX_JOB_BUDGET=5`). Decided 2026-10-02.
- [ ] **Who may create jobs.** Suggested: only you at first, then invited owners.
- [x] **Operator funding: 1 USDC.** Decided 2026-10-02. Measured: Bursar's transactions use 71k to
      94k gas; at mainnet's 20 gwei that's about 0.0015 to 0.002 USDC each, so roughly 300 to 500
      operator transactions. Payments stall (nothing is lost) if it runs dry.
- [ ] **Demo.** Suggested: no autopilot demo job on mainnet; keep the demo on testnet.

## 1. Code changes (done on branch `mainnet-prep`)

- [x] `packages/payments/src/gateway.ts`: `eip155:5042` is in `GATEWAY_NETWORKS` with the mainnet
      wallet, minter, domain 26 and API URL above.
- [x] `apps/web/src/lib/config.ts`: the console builds for mainnet when `VITE_ARC_CHAIN_ID=5042`
      (chain, explorer and vault follow). A mainnet build without `VITE_JOB_VAULT_ADDRESS` fails
      instead of falling back to testnet's vault. Every other build is testnet, as today.
- [x] A per-job budget cap, `MAX_JOB_BUDGET` (USDC, e.g. `5`), on the API and the worker. The API
      refuses a larger job (`BUDGET_ABOVE_CAP`); if an owner raises a budget on-chain past it, the
      worker counts only up to the cap and the rest goes back to them at close. Unset means no cap.
- [x] A "Mainnet" badge in the console header on the mainnet build (a quiet "Testnet" one
      otherwise), and the landing page names the right network.
- [x] Tests for each; full suite and lint green; the console builds for both networks.

The contracts don't change. `JobVault` and `AuditAnchor` have no chain-specific values.

## 2. Keys (you)

- [ ] A **new operator key** for mainnet, never used on testnet. It can release funds within each
      job's rules and anchor the log, so it matters most. Keep it only in Render's secret env.
- [ ] A **deployer key** with a few cents of USDC on mainnet. It gets no role in either contract.
- [ ] A **Circle production account**: API key, a new entity secret, and a wallet set on `ARC`.
      Testnet Circle credentials don't work on mainnet.
- [ ] Fund the operator address with the agreed USDC (gas on Arc is USDC).

## 3. Deploy the contracts (you run it, or I prepare the exact command)

```bash
cd contracts
USDC_ADDRESS=0x3600000000000000000000000000000000000000 OPERATOR_ADDRESS=<new operator address> \
  forge script script/Deploy.s.sol --rpc-url arc_mainnet --broadcast --private-key <deployer key>
```

- [ ] Writes `contracts/deployments/5042.json` with both addresses and the deploy block. Commit it.
- [ ] Verify both contracts on `explorer.arc.io`.
- [ ] Check on-chain: `operator()` on both is the new operator, `usdc()` on the vault is USDC.

## 4. Database

- [ ] A new Neon database (or branch) for mainnet. Never share one with testnet.
- [ ] Run the migrations against it (direct URL, not the pooled one).
- [ ] Fill in `NEON_DATABASE_URL_DIRECT` in `.env`; it's empty today.

## 5. Services

- [ ] A second Render service for the mainnet API and worker, same repo and branch, with:
      `ARC_CHAIN_ID=5042`, `ARC_RPC_URL` (a mainnet RPC; Canteen's if it serves mainnet),
      `USDC_ADDRESS`, `JOB_VAULT_ADDRESS`, `JOB_VAULT_DEPLOY_BLOCK`, `AUDIT_ANCHOR_ADDRESS`,
      `OPERATOR_PRIVATE_KEY`, `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `CIRCLE_WALLET_SET_ID`,
      `DATABASE_URL`, `WEB_URL`, `WEB_ORIGINS`, `MAX_JOB_BUDGET`, `AUTOPILOT=false`, and no
      `DEMO_*` values.
- [ ] A second Vercel project for the mainnet console: `VITE_ARC_CHAIN_ID=5042`,
      `VITE_JOB_VAULT_ADDRESS`, `VITE_API_URL` (the mainnet API) and its own domain.
- [ ] `bursar-mcp` needs no change: an agent points `BURSAR_API_URL` at the mainnet API.

## 6. First real job (you, with me watching)

- [ ] Create a job with a 1 USDC budget and a $0.10 approval threshold.
- [ ] Allow-list one live mainnet seller (Exa or Orthogonal's Serper, from Circle's Agent
      Marketplace), connect an agent and buy once.
- [ ] Approve one payment above the threshold.
- [ ] Press Verify on the evidence page; check the anchor lands on `explorer.arc.io`.
- [ ] Close the job and check the remainder returns to your wallet.

## 7. Before inviting anyone else

- [ ] A second look at `JobVault` with real money in mind (access control, the release and refund
      paths, the approval signature domain). It hasn't had an external audit.
- [ ] Alerts on: operator balance low, a frozen job, an unresolved payment.
- [ ] README and docs: say which links are mainnet and which are testnet.

## Rough cost

| Item                       | USDC                               |
| -------------------------- | ---------------------------------- |
| Deploying both contracts   | a few cents                        |
| Operator gas float         | 1                                  |
| First test job             | 1 (most of it comes back on close) |
| **Total at risk to start** | **about 2**                        |
