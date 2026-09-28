# Day 2 spike: can a Circle agent wallet pay x402 on Arc testnet?

**Result: yes.** Option A from `PLAN.md` §8.1.4 (top up the job's agent wallet, the agent wallet pays the x402 seller, leftovers go back) works end to end on Arc testnet.

Date: 2026-09-27. Network: Arc testnet (chain ID 5042002).

## Evidence

| Step                                                                                                                                                     | Transaction                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Agent wallet's first transaction (deploys the smart-contract wallet; 0.01 USDC to the dev wallet, which also proves the "send leftovers back" direction) | [`0x53deffb2…f506`](https://testnet.arcscan.app/tx/0x53deffb2189d8a51b3b95a7c6f1995765e1b4065e982b7bab881168b8198f506) |
| x402 payment: agent wallet → our seller, 0.01 USDC, settled by Circle's Facilitator                                                                      | [`0xf8c4a4db…3749`](https://testnet.arcscan.app/tx/0xf8c4a4db5340c7b673f0807a19c3a6e62a5dae1abddfb2276a56a95cf3e93749) |
| Top-up: dev wallet → agent wallet, 0.05 USDC (stands in for `JobVault.release`)                                                                          | [`0x101eb996…7c8b`](https://testnet.arcscan.app/tx/0x101eb996e135dcc0113c91955599f6dcd104a244768a1c69bba3723514a87c8b) |

| Address                                      | Role                                        |
| -------------------------------------------- | ------------------------------------------- |
| `0x190a23d9d55b6f1749992134dd4d2292794fd113` | Circle agent wallet (buyer)                 |
| `0xc140E91475BfA94C0A7531d8A0CBc018aE1d277e` | Our seller (payTo), test-only key in `.env` |
| `0xE3C87a19Af3bEE009eFE9c4d61601DA5458Cf9c9` | Dev wallet (arc-canteen)                    |

To reproduce: `pnpm --filter @bursar/seller start`, then
`circle services pay http://localhost:4021/v1/insight --address <agent wallet> --chain ARC-TESTNET --max-amount 0.01`.

## Findings

### USDC on Arc

1. Supports **EIP-3009** (`transferWithAuthorization`, used by x402) and **EIP-2612** (`permit`, for one-transaction vault funding). Domain: name `USDC`, version `2`.
2. Also has the **bytes-signature** overload of `transferWithAuthorization`, which accepts contract (ERC-1271) signatures. The facilitator accepted our smart-contract agent wallet's signature, so option B (the vault itself as x402 payer) is technically possible. Not pursued; option A works.
3. Every USDC transfer emits **two** `Transfer` logs: one from the USDC contract `0x3600…0000` (6 decimals) and one from the native system address `0xffff…fffe` (18 decimals). **The indexer must read only `0x3600…0000` logs** or it will double count.
4. x402 settlement emits `AuthorizationUsed(authorizer, nonce)` on USDC. The reconciler can match a signed payment by nonce from this event.

### Circle agent wallets

5. An agent wallet is a **smart-contract account that isn't deployed until its first transaction**. Signing fails before then ("This wallet isn't deployed on-chain yet"). **Every new job wallet needs a first transaction to deploy it**, e.g. the first top-up flow must include one outgoing transfer, or we deploy at job creation.
6. **Gas is sponsored**: the wallet's USDC balance dropped by exactly the amounts sent. No gas token or Paymaster setup was needed on our side for agent-wallet transactions.
7. Circle CLI details: `services pay --max-amount` enforces a client-side price cap; `wallet limit` (spending policy) is **mainnet only**; `--idempotency-key` must be a UUID; login sessions last 28 days and have a non-interactive two-step form (`--init`, then `--request <id> --otp <code>`).

### x402 on Arc testnet

8. Circle's marketplace lists ~900 x402 services; 137 of the first 200 accept **Arc mainnet** and **none accept Arc testnet**. On testnet our agents can only buy from sellers we run, so `apps/seller` is required, not optional.
9. Circle's **Facilitator Service supports Arc testnet with a keyless trial** (no account). Requests are authenticated by a **seller proof**: an EIP-712 signature by the payTo key over purpose, method and the keccak256 of the exact body. The stock `HTTPFacilitatorClient` can't produce it (its header hook never sees the body), so `apps/seller/src/circle-facilitator.ts` signs each request itself.
10. The keyless trial has a per-payTo allowance per chain. When it's used up, `/settle` returns `403 registration_required` and a Circle API key is needed. **Get a Circle Console API key before traction work ramps up (by day 7).**
11. `/settle` can answer `settlement_pending`; the client polls `/status/{paymentId}` rather than treating it as failure (matches the plan's `UNRESOLVED` rule).

## Open decisions (for days 3–5)

- **How the backend drives agent wallets**: shelling out to the Circle CLI (works today, session tied to your email login) vs Circle's Developer-Controlled Wallets API (needs Console API key + entity secret, better for a hosted server). Decide by day 5.
- **Deploying job wallets**: one agent wallet per job means one deployment transaction per job. Check whether the CLI can create more agent wallets per chain, or whether one agent wallet per owner is the practical unit.
