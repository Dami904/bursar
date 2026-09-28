# External API notes

How each external system Bursar depends on actually behaves: what a success means, what a timeout
means, and what a retry does. Written from what we observed (days 2 and 4), not only from docs.
The payment path is designed around these answers.

## Arc testnet RPC (`rpc.testnet.arc.io`, personal Canteen RPC)

- Deterministic finality, sub-second blocks. A mined receipt is final; no confirmation depth needed.
- **Flaky transport**: TLS handshakes occasionally fail (`BadRecordMac`), seen on day 4 on both the RPC
  and the explorer. Reads are retried; a failed _broadcast_ is treated as UNKNOWN, never as FAILED.
- Every USDC transfer emits **two** `Transfer` logs: one from USDC `0x3600…0000` (6 decimals) and a
  native one from `0xffff…fffe` (18 decimals). Only the USDC contract's logs are read.
- Gas is paid in USDC (native balance, 18 decimals).

## JobVault (our contract)

- `release` is idempotent **on the semantic action**: an operation ID can release at most once,
  forever (`OpAlreadyUsed`). So re-sending a release after a timeout can never pay twice.
- `releasedFor(jobId, opId)` is the source of truth for "did this release happen": non-zero = yes.
  The worker reconciles an uncertain release by reading it, not by trusting a receipt it may not have.
- A revert is positive proof of FAILED for that attempt. `StalePolicy` means the owner changed the
  rules after the decision: the authorization is released, not retried.

## AuditAnchor (our contract)

- `anchor(head, seq, decisions)` accepts only `seq == latestSeq + 1`. An anchor can't be skipped,
  replaced or replayed, so a lost transaction can't be double-posted. A resend at a stale seq
  reverts with `BadSequence`.
- The worker treats `anchors(seq).head` on-chain as the source of truth, not its own receipt. A
  sent anchor counts as confirmed only when the chain holds exactly our head at that seq.
- `decisions` is set to the audit log's entry count at the anchored head.
- The log is verified end to end before every anchor, so a broken log is never anchored.
- Invoices use `JobVault.release(to = vendor)`: the vendor must be `setPayee`'d by the owner. The
  approver signs over the vendor's address (EIP-712 `to`), not the job wallet's.

## Circle developer-controlled wallets (`@circle-fin/developer-controlled-wallets` 10.8.1)

- Auth: API key + entity secret (registered once per Circle account; any key in that account works).
- `createWallets` is synchronous: the response contains the wallet's id and address.
- `signTypedData` is synchronous and **moves no money**: it returns a signature (verified day 5: an
  EOA on `ARC-TESTNET` signs EIP-712 and the signature recovers to the wallet address).
- EOA wallets need no deployment transaction (unlike the CLI's smart-contract agent wallets).
- **Confirmed live day 5**: a job's EOA signed an x402 EIP-3009 payment and Circle's Facilitator
  settled it. The payer needs **no gas**: the facilitator submits the transfer. A job wallet only
  needs gas to send money _back_ (refunds, day 6).
- Circle's `signTypedData` needs the `EIP712Domain` type listed explicitly in the JSON it's given;
  the x402 library omits it (viem infers it), so the adapter adds it.
- Transfers (`createTransaction`) are asynchronous: the response is an acknowledgement with a
  transaction id; the outcome must be polled. They accept an `idempotencyKey` (UUID).
  **Confirmed live day 6**: a job wallet sent 0.01 USDC back to the vault with
  `walletAddress` + `blockchain` + `tokenAddress` (the USDC ERC-20 address). The EOA pays gas from
  its own (USDC) balance, so it needs a small top-up first.
- **Circle reserves the maximum fee before sending** (gas limit x max fee, ~0.0035 USDC for an
  ERC-20 transfer on Arc testnet), although it charges only the real fee (~0.0015). A transfer that
  leaves less than the reserve fails with `INSUFFICIENT_NATIVE_TOKEN` (seen live on the first sweep).
  A failed transfer's idempotency key returns the same failed transaction, so retries need a new key.

## x402 sellers (HTTP)

- Unpaid request → `402` with a base64 `PAYMENT-REQUIRED` header (x402 v2): `accepts[]` lists scheme,
  network (CAIP-2), asset, amount (base units), `payTo`, `maxTimeoutSeconds`.
- Paid request → the resource plus a base64 `PAYMENT-RESPONSE` header containing the settlement
  (`success`, `transaction`, `payer`, `network`).
- The payment is an EIP-3009 `transferWithAuthorization` signed by the payer: a random 32-byte nonce
  and a `validBefore` expiry. **The nonce makes it idempotent on the semantic action**: USDC refuses
  a used nonce, so re-sending the same signed payment can't pay twice.
- A timeout or dropped response after sending the signed payment is UNKNOWN: the seller may have
  settled. Reconcile via USDC's `authorizationState(payer, nonce)`: `true` = settled; `false` after
  `validBefore` = never settled and never can be.
- We persist payer, nonce and `validBefore` **before** sending the payment, so an UNKNOWN can always
  be reconciled.

## Circle Facilitator (seller side, keyless trial)

- `/settle` always answers HTTP 200: `success: true` with a tx hash, or `success: false` with
  `errorReason`. `settlement_pending` is **not** failure; poll `/status/{paymentId}`.
- Idempotency via the `payment-identifier` extension, or by resubmitting the exact same signed
  authorization. Never re-sign to retry.
- Keyless trial allowance per `payTo`; once exhausted, `403 registration_required`.
