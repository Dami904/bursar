# Spike: one-confirmation job setup (EIP-5792 bundles)

**Status:** experiment, **testnet only**, off by default. Turn it on with `VITE_BATCH_SETUP=true`
at build time. A mainnet build ignores the setting (enforced in `config.ts` and tested).
**Goal:** job setup normally asks the wallet three times (open, allow, deposit). On a wallet that
can run a bundle all-or-nothing, it can be one.

## What is known

| Question                                                            | Answer                                                           | Evidence                                                                                                                                                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does Arc (testnet and mainnet) accept EIP-7702 upgrades?            | Yes                                                              | Both RPCs accepted a type-4 transaction in `eth_estimateGas` and `eth_call`; the estimate included the 25,000 gas upgrade charge. Checked 2026-11-10 with a throwaway key; nothing was sent. |
| Is ERC-4337 available?                                              | Yes                                                              | EntryPoint v0.6 and v0.7 are deployed on both; [Arc's docs](https://docs.arc.io/arc/tools/account-abstraction) list bundlers.                                                                |
| Does Arc's documentation mention EIP-5792 or EIP-7702?              | No                                                               | The same page covers only ERC-4337.                                                                                                                                                          |
| Which wallets offer bundling on Arc?                                | **Unknown: this is what the spike finds out**                    |                                                                                                                                                                                              |
| Do an owner's approvals still work after their address is upgraded? | **Only if the delegate vouches for their signatures (ERC-1271)** | `contracts/test/JobVault.delegation.t.sol`: a silent delegate makes the vault refuse the approval (`BadApproval`); a vouching delegate works; a forged signature is still refused.           |

The last row is why this is a switch. An upgraded address has code, and the vault then asks that
code to vouch for the owner's approval signature instead of checking it directly. A wallet whose
upgrade doesn't vouch would leave the owner unable to approve payments. Funds stay safe (a payment
just waits), but the job's approval path is dead.

## How the experiment behaves

With the switch on, the console asks the connected wallet what it can do (`wallet_getCapabilities`).
Only if it reports atomic support on Arc does setup become: create the job in Bursar, then **one**
bundle (open the job, allow exactly the deposit, deposit, and register the owner as approver when a
payment can need approval; vendor addresses last), sent with `forceAtomic` so a wallet that can't
do it all-or-nothing refuses instead of running it in pieces. Anything else uses the normal
three-confirmation flow. A banner says it's an experiment and offers separate confirmations. If the
owner's address ends up upgraded, the success screen says so and asks for a test payment.

## Test procedure (testnet only)

For each wallet, on a testnet build with `VITE_BATCH_SETUP=true`:

1. Connect, start a new job with budget 1.00, approval threshold 0.10, no vendors.
2. Does the setup screen say "once" and show one confirmation? Record yes/no.
3. Confirm. Does the job go active? Did the wallet show what the bundle does before you confirmed?
4. Does the success screen warn that the address was upgraded? Note the delegate address shown.
5. Give the job a brief that buys something above 0.10 (or have an agent request such a payment),
   then press **Approve**. **This is the real test:** it must end with the payment paid.
6. Repeat steps 1–5 once with "Use separate confirmations instead" as a control.

## Results

| Wallet and version           | Offers a bundle on Arc? | Setup confirmations | Upgrades the address? | Approval after bundle works? | Verdict |
| ---------------------------- | ----------------------- | ------------------- | --------------------- | ---------------------------- | ------- |
| MetaMask                     |                         |                     |                       |                              |         |
| Rabby                        |                         |                     |                       |                              |         |
| A WalletConnect phone wallet |                         |                     |                       |                              |         |
| Coinbase Smart Wallet        |                         |                     |                       |                              |         |

**Rule for turning it on:** a wallet counts as safe only when step 5 passes. Until a row says so,
mainnet stays off. Enabling it there would be a deliberate code change, not a setting. A smart-contract wallet as the owner is
a separate problem: Bursar's API verifies approvals as plain-wallet signatures, so don't use one.

## Undoing an upgrade

If a wallet upgraded an address and approvals fail, look for a way to switch that address back to a
standard account in the wallet. How, and whether it is offered at all, differs by wallet and is
**not yet checked**: record it per wallet in the table above before anyone relies on this.
