# Day 6: refunds and human approvals, live on Arc testnet

Date: 2026-09-28. Network: Arc testnet (5042002). Vault: `0x5Cd51a31fE931D31574Eadd083A0B5c210CA2cB6`.

## 1. A refused payment is refunded to the vault

The agent bought from `/v1/refuses`, a seller route that quotes a price but refuses every payment
(its signed payments expire after 30 seconds).

| Step                                                                                   | Evidence                                                                                                         |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Decision ALLOWED; vault released 0.01 to the job wallet                                | [release](https://explorer.testnet.arc.io/tx/0xc32353113d1a1ca59effedaeb46948b9586f1455ae63d249bd931734bf3ad3d5) |
| Seller refused → purchase `UNRESOLVED`, money still counted                            | "The seller refused the payment (HTTP 402); USDC is in the job wallet"                                           |
| Reconciler waited until the signature expired **by chain time**                        | no action while it could still be settled                                                                        |
| Operator topped up the job wallet's gas (Arc gas is USDC)                              | [top-up](https://explorer.testnet.arc.io/tx/0x28f70ac63685fe69a55eb719f90b85fc89491c22aab4a007de16a264aded7e5c)  |
| Circle transferred 0.01 USDC from the job wallet back to the vault                     | Circle transaction `6ab9162d-4f03-5407-b02a-91b392aa3b42`                                                        |
| `JobVault.refund` credited the job                                                     | [refund](https://explorer.testnet.arc.io/tx/0x35af012dbba863489e3fefd00e262661a48db1f8ad17fdcd6ef5cdb64ad81427)  |
| Purchase `RELEASED`: "Payment failed; USDC returned to the vault and the job credited" |                                                                                                                  |

Afterwards: vault `available(job)` back to 0.49 (exactly where it was before), Bursar's ledger shows
nothing reserved or unresolved. About 0.0085 USDC of the operator's gas top-up remains in the job
wallet as dust.

## 2. A payment above the threshold waits for a human, then goes through

A new job with an approval threshold of 0.005 USDC; the owner registered an approver wallet in
Bursar and allowed it on-chain ([setApprover](https://explorer.testnet.arc.io/tx/0x190823536768dfece9cfa1b90f6e74adf71d1b94631495f2f763f144a4bfbcf6);
the indexer picked up `policyVersion` 2).

| Step                                                                                         | Evidence                                                                                                                                           |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent's 0.01 purchase → `NEEDS_APPROVAL`, money held as pending, HTTP 202                    |                                                                                                                                                    |
| Approver fetched `GET /approvals`, signed exactly the EIP-712 message returned, submitted it | API verified the signature and signer → `RESERVED`                                                                                                 |
| Worker released with the approval attached                                                   | [release](https://explorer.testnet.arc.io/tx/0x5e40a2d5be66141dd5dafba99ad0ae8d71413d6ca1a9d6f268400bdea1008c26): `Released(..., approved = true)` |
| Job wallet paid the seller; settlement confirmed on-chain                                    | [payment](https://explorer.testnet.arc.io/tx/0x842488478d7043039ec467b909ccec7350fd96160a811c5b513ded5e14538434)                                   |

The `approved = true` flag is set by JobVault itself after verifying the approver's signature, so
the approval is enforced on-chain, not just recorded by Bursar.

Worker log for both runs: 0 errors; 1 warning (the deliberate refusal).
