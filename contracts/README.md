# contracts

Solidity contracts for Bursar, built and tested with Foundry (see `PLAN.md` §8.1).

| Contract      | Role                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JobVault`    | Holds each job's USDC; enforces budget, deposit, per-payment cap, window cap, payee allow-list, once-only operation IDs, EIP-712 approvals, pause, refund |
| `AuditAnchor` | Stores the head of Bursar's hash-chained decision log, in strict sequence                                                                                 |

## Deployed on Arc testnet (chain 5042002)

| Contract                    | Address                                                                                                                            | Source   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `JobVault`                  | [`0x5Cd51a31fE931D31574Eadd083A0B5c210CA2cB6`](https://explorer.testnet.arc.io/address/0x5cd51a31fe931d31574eadd083a0b5c210ca2cb6) | Verified |
| `AuditAnchor`               | [`0xabAC55f7D30f14275E00393E2307857301Db236c`](https://explorer.testnet.arc.io/address/0xabac55f7d30f14275e00393e2307857301db236c) | Verified |
| `AuditAnchor` (development) | [`0x8f919903261AB618537DC0a114E6B46C99Db8727`](https://explorer.testnet.arc.io/address/0x8f919903261ab618537dc0a114e6b46c99db8727) | Verified |

The production AuditAnchor was deployed on its own (`forge create`) when the live service moved to a fresh database: an anchor's decision count can never go down, so a new log needs a new anchor. It was replaced once more on 7 October 2026 (`0xCe76d1DAcbECd7dc4f6D881D673b981EdEE58ac4`, retired at anchor 54) when the testnet database was recreated and its log started again from zero. The development one keeps the anchors made while building.

Operator: `0xC2D41C50Ef647B0Ae52aA3afEa5dD876d27E6deE`. USDC: `0x3600000000000000000000000000000000000000` (ERC-20 interface, 6 decimals). Machine-readable: [`deployments/5042002.json`](deployments/5042002.json).

Live smoke test on the deployed vault: a job created, funded with 0.10 USDC and allow-listed a payee; the operator released 0.01 ([`0x124383ae…33ff`](https://explorer.testnet.arc.io/tx/0x124383ae86b117d4cbc253397b766af1c895dbc9692471f11cfb1c82486533ff)); a retry of the same operation ID reverted `OpAlreadyUsed` and a non-allow-listed payee reverted `PayeeNotAllowed`.

## Who can do what

| Role     | Can                                                                                                             | Can't                    |
| -------- | --------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Owner    | Create and close jobs; set budget, caps, window, payees and approvers; pause and unpause; get unspent USDC back | Release money            |
| Operator | Release within a job's rules; record refunds; pause in an emergency; anchor the audit log                       | Change any rule; unpause |
| Approver | Sign an EIP-712 approval for one release above the threshold                                                    | Anything else            |
| Anyone   | Fund a job (so a customer can pay revenue straight in)                                                          | Take money out           |

Every rule change bumps the job's `policyVersion`. A release names the version Bursar decided under and reverts `StalePolicy` if the owner changed the rules since; approvals are signed over the version too, so they die with a rule change.

## Tests

```sh
forge build
forge test                 # unit, fuzz, invariant and policy-parity tests
forge coverage --report summary --no-match-coverage "test/|script/"
python -m slither .        # config and justified exclusions in slither.config.json
```

- **Invariants** (256 runs × 64 calls): spent never exceeds budget or deposits; the vault's balance always covers what it owes; spend equals releases minus refunds; an operation ID never releases twice.
- **Policy parity**: `test/fixtures/policy-parity.json` is generated from `packages/policy/vectors` (`pnpm --filter @bursar/policy export:parity`). Every on-chain case must match the TypeScript policy engine, and a TypeScript test fails if the fixture is stale.
- Coverage: 100% of lines in both contracts.

## Deploy

```sh
USDC_ADDRESS=0x3600000000000000000000000000000000000000 OPERATOR_ADDRESS=0x... \
  forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast --private-key <deployer>
forge verify-contract <address> src/JobVault.sol:JobVault --verifier blockscout \
  --verifier-url https://explorer.testnet.arc.io/api/ --chain-id 5042002 --constructor-args <abi-encoded>
```

Libraries (git submodules): `forge-std`, `openzeppelin-contracts` v5.7.0. After cloning the repo run `git submodule update --init --recursive`.
