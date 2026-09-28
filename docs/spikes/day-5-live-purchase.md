# Day 5: first end-to-end purchase through Bursar on Arc testnet

**Result: an AI agent bought an x402 resource through Bursar, and every hop was enforced and
confirmed on-chain.** 22 seconds from request to paid content.

Date: 2026-09-28. Network: Arc testnet (5042002). Vault: `0x5Cd51a31fE931D31574Eadd083A0B5c210CA2cB6`.

## What happened

1. **Owner created a job over the API.** Bursar gave it its own Circle developer-controlled wallet
   (`0x41048de7…4b96`, created live) and a derived vault id. The job started in `DRAFT`.
2. **Owner created and funded it in JobVault** (0.50 USDC, per-payment cap 0.20):
   [createJob](https://explorer.testnet.arc.io/tx/0x2b6b45d3dfd10e6c38432b7f8007ba9a0f9db0fa85369596b9fd2a3fdfad9122),
   [fund](https://explorer.testnet.arc.io/tx/0x822de7ab356379e0eb615a624b7ba205a7080a757ef48a3acaab99f619dcb71b).
3. **The indexer saw the events and activated the job**: `ACTIVE`, 0.50 deposited, `policyVersion` 1.
4. **Owner allow-listed the seller and created an agent key.**
5. **The agent called `POST /spend/purchase`** with the seller's URL and a max price of 0.05 USDC.
   Bursar checked the allow-list, quoted the seller (0.01 USDC), ran the policy (ALLOWED) and
   reserved 0.01.
6. **The worker released exactly 0.01 from the vault to the job wallet**, citing the policy version
   the decision was made under:
   [release](https://explorer.testnet.arc.io/tx/0xe4b1592c0795ce2eea81f711c541eebc9452904f7e66afb75b14d51f4c869638).
7. **The job wallet signed the x402 payment** (Circle `signTypedData`); payer, nonce and expiry were
   saved before sending.
8. **The seller settled it through Circle's Facilitator**:
   [payment](https://explorer.testnet.arc.io/tx/0x23d0d6e51d4ba855096f03add4fc4c4bad27bf66adc948b2f051879f39fd7f0a).
   The worker confirmed it against USDC's `authorizationState(payer, nonce)` before marking it settled.
9. **The agent got the paid content back** in the same HTTP response.

## Independent checks afterwards

| Check                            | Result                                                            |
| -------------------------------- | ----------------------------------------------------------------- |
| Vault `available(job)`           | 0.49 USDC (0.50 − 0.01)                                           |
| Job wallet USDC balance          | 0: it received exactly 0.01 and paid exactly 0.01                 |
| Both transactions                | `status: success`                                                 |
| Bursar's ledger                  | settled 0.01, reserved 0, unresolved 0, remaining 0.49            |
| Retry with the same operation ID | Returned the original decision (`replayed: true`); no money moved |
| Worker log                       | No warnings or errors                                             |

## Reproduce

```sh
docker compose up -d
pnpm --filter @bursar/seller start & pnpm --filter @bursar/api start & pnpm --filter @bursar/worker start &
pnpm --filter @bursar/api owner:create "My Studio"          # prints an owner key once
# POST /jobs → note onChain.vaultJobId and onChain.agentWallet
pnpm --filter @bursar/worker onchain:job <vaultJobId> <agentWallet> 0.50 0.20 0.20 0.50 0.50
# POST /jobs/:id/payees {"kind":"X402_ORIGIN","value":"http://127.0.0.1:4021"}
# POST /jobs/:id/agents → agent key
# POST /spend/purchase {"operationId":"...","url":"http://127.0.0.1:4021/v1/insight","maxPrice":"0.05","reasoning":"..."}
```
