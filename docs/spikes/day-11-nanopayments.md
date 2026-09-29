# Day 11: nanopayments through Circle Gateway

29 Sep 2026. Agents can now buy sub-cent items (0.001 USDC) under the same job budget and rules as
every other payment. Bursar pays them through Circle Gateway (Nanopayments): each payment is a
signature Circle confirms in about a second, with no gas, and settles on Arc in batches.

## Proven in production

- **The AI operator bought three 0.001 sound cues and a 0.002 caption from Scenestock, on its own,
  within a minute of getting the brief.** The worker released a 0.10 float from the vault
  ([release](https://explorer.testnet.arc.io/tx/0xed118bd9e2181f1bbe184eba6990b4b49846e12eeddd0f49524ece9501d6e3be)),
  the job's Circle wallet deposited it into Gateway
  ([deposit](https://explorer.testnet.arc.io/tx/0xefd1b614f790fa5e3d115adb539b868b634e8650f2ee4c2d6ad4bca00c0ef8f9)),
  and all four payments settled with Circle transfer ids. Every one passed 12 of 12 rules and has an
  evidence page, e.g. [the caption](https://bursarhq.vercel.app/demo/decisions/c32c366e-fcb5-4732-817a-f507c8902902).
- **The budget counts the float once.** The demo job shows 0.005 drawn and 0.095 unspent in Gateway,
  and 1.79 left of 2.00: 0.115 paid plus the 0.095 float, which counts in full from the moment it
  leaves the vault.
- **Withdrawing from Gateway works on Arc with Bursar's own code** (on a test wallet): the whole
  balance came back in about 2.5 s, Circle charged its flat 0.0035 fee and marked the withdrawal
  finalized with our mint transaction. Closed jobs now return their unspent float to the owner this
  way.

## How it works

| Step              | What happens                                                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quote             | The seller's 402 offers Circle's `GatewayWalletBatched` scheme. The payment gets `rail = GATEWAY` (a plain on-chain option is preferred if offered).                                                                               |
| Decide            | The same 12 rules. A payment the unspent float covers doesn't count against the budget a second time.                                                                                                                              |
| Float             | If the job's Gateway balance is short, a float (0.10, capped by the per-payment cap, approval threshold and remaining budget) is released from the vault with its own operation id, then approved and deposited by the job wallet. |
| Pay               | The job wallet signs the batched payment; Bursar sends it and confirms with Circle's transfers API before calling it paid.                                                                                                         |
| Refused / unknown | Refused: back to the float. Unknown: settled if Circle has it, back to the float after 10 minutes if not.                                                                                                                          |
| Close             | The job wallet signs a burn intent for the unspent float, Circle attests it, and the operator mints it on Arc to the job's on-chain owner.                                                                                         |

Postgres's budget check includes the unspent float, so float plus spending can never exceed the
budget even if the application had a bug.

## Findings

- **Paymaster isn't available on Arc, and isn't needed.** Circle's Paymaster covers Arbitrum,
  Avalanche, Base, Ethereum, Optimism, Polygon and Unichain; on Arc, gas is already USDC.
- **Circle's `BatchFacilitatorClient` and `createGatewayMiddleware` default to mainnet.** Pass
  `https://gateway-api-testnet.circle.com` on testnet, or every quote fails with "No payment
  networks available".
- **Gateway signatures use Circle's GatewayWallet as the EIP-712 verifying contract** and need at
  least 7 days' validity; Circle's batching client handles both.
- **Deposits are credited about 20 s after the deposit transaction.** Payments then take about 1 s.
- **Withdrawals:** `/v1/estimate` returns the fee to sign (`maxFee` 0.00385; 0.0035 is charged).
  Circle refuses the same burn intent twice ("Transfer spec has already been used") and the minter
  refuses the same attestation twice. Circle only burns once it sees the mint, so a lost
  attestation expires and the balance returns. The estimate returns addresses unpadded: sign your
  own `bytes32` spec, not Circle's echo.
- **`GET /v1/transfer/{id}`** gives a withdrawal's status and mint transaction; there's no way to
  list withdrawals by depositor, so Bursar saves the signed intent before sending it and Circle's
  reply the moment it arrives.

## Tests

307 TypeScript tests (up from 288). New: rail selection and Gateway signing checked against Circle's
domain; float accounting and the Postgres check; and the whole lane on a local chain against a
stand-in for Circle's Gateway API (float, payment, seller crash after Gateway took it, refusal,
reconciling unknown outcomes, and returning a closed job's float).
