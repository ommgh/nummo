# 03. Solana settlement

How money moves. Everything here uses existing on-chain programs. Items marked **verify** are assumptions to confirm in the spikes listed in [05-roadmap-and-grant.md](05-roadmap-and-grant.md).

## The primitive we build on

The Subscriptions program ([overview](https://solana.com/docs/payments/subscriptions/overview)).

- Program ID: `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`, on mainnet and devnet.
- Audited by Cantina. Source: [solana-program/subscriptions](https://github.com/solana-program/subscriptions).
- Works with SPL Token and Token-2022 mints.
- TypeScript SDK: `@solana/subscriptions`, used with `@solana/kit`.

A Solana token account can approve only one delegate. The program works around this with a **Subscription Authority**, one per (user, mint). The user's token account approves that authority once, and the program then checks every pull against a separate record that says who may pull, how much, and until when.

It offers three kinds of record:

| Kind | Who sets the terms | Limit | Who can pull |
| --- | --- | --- | --- |
| Fixed delegation | The user | A fixed total, optional expiry | The named delegatee |
| Recurring delegation | The user | An amount per period that resets | The named delegatee |
| Subscription plan | The merchant publishes, the user accepts | The plan amount per period | The plan owner and its listed pullers |

## Facts about subscription plans that shape the design

From the [subscription plan guide](https://solana.com/docs/payments/subscriptions/subscription-plan) and the [pay.sh protocol notes](https://pay.sh/docs/building-with-pay/subscriptions/protocol).

1. A plan belongs to the merchant. Its address is derived from the merchant's address and a numeric `planId`.
2. `amount` and `periodHours` cannot change after creation. The merchant can change status, pullers, the metadata URI, and can shorten the end date.
3. Each subscriber's record snapshots the terms at the moment they subscribe.
4. The merchant or a listed puller collects **up to** the plan amount each period. The collect instruction takes an explicit `amount`.
5. If the plan lists `destinations`, the receiving token account's owner must be on that list.
6. Periods are a fixed number of hours. There is no calendar month; 720 hours is 30 days.
7. Missed periods do not accumulate. If a period passes without a pull, that period's allowance is gone.
8. The subscriber cancels by signing `cancelSubscription`. The subscription then ends at the end of the current period. Ending it immediately needs both the subscriber's and the merchant's signature.
9. A subscriber can close their Subscription Authority, which ends every subscription on that mint at once.
10. One subscription exists per (plan, subscriber wallet).

## Design decision D3: the plan amount is a ceiling

We create one on-chain plan per plan version and set its `amount` to the most that version can ever charge in a period: the base fee plus the overage cap. We then collect with partial pulls.

| Pricing model | On-chain plan amount | Pulls in a period |
| --- | --- | --- |
| Flat 20 USDC | 20 | One pull of 20 at period start |
| 20 USDC base, overage capped at 50 | 70 | 20 at period start, then overage as it accrues, never past 70 in total |
| Pay as you go with auto top-up, at most 100 a period | 100 | One pull per refill |

Why this is the right shape:

- One primitive covers every paid model.
- The ceiling the customer signs is public, immutable, and enforced by the program. Our software cannot overcharge even if it has a bug.
- The `destinations` list means a stolen puller key can only send funds to the merchant's own wallets.
- Plan immutability lines up with plan versioning. A price change is a new on-chain plan; customers on the old one are grandfathered automatically.

**Spike S1 (2026-11-17): confirmed on devnet, and in the program source and its tests.** Each pull adds to `amount_pulled_in_period` and fails with `AmountExceedsPeriodLimit` (error 400) only once the total would pass the plan amount. Periods advance in whole steps from the subscribe time, so every boundary is `currentPeriodStartTs + k × period`. Details are in [spikes/README.md](../spikes/README.md).

**Fallback if S1 fails:** a plan for the base fee, plus a recurring delegation for overage and top-ups, both created in the same activation transaction. The recurring delegation has no destination allowlist, so the delegatee key becomes more sensitive. See key custody below.

**Later option:** let a customer choose a lower personal cap. The on-chain ceiling stays as published and our ledger enforces the lower number. A customer who wants their own cap enforced on-chain would use a recurring delegation, which they define themselves.

## Activation: one signature

Modelled on the flow pay.sh uses. The checkout builds one transaction and the customer signs it once.

```
1. SetComputeUnitLimit, SetComputeUnitPrice
2. initSubscriptionAuthority        only if this wallet has none for the mint
3. subscribe                        creates the subscriber record with the plan terms
4. transferSubscription             first charge: base fee, or the first top-up
Fee payer: the merchant's puller wallet
Signers:   the customer, then the puller (added by our server)
```

Steps:

1. The merchant's backend calls `attach`. We create a pending subscription and return a checkout URL.
2. The checkout connects the wallet, fetches the on-chain plan, and shows the price, period and ceiling read from the chain.
3. Our server builds the transaction. To bundle steps 2 and 3 for a new wallet, the SDK's `UNKNOWN_INIT_ID` sentinel is passed as the expected authority id. A returning wallet passes its real id.
4. The wallet signs and returns the transaction. It does not broadcast.
5. Our server checks that the returned transaction contains exactly the instructions it built, adds the puller's signature, and broadcasts.
6. On confirmation we mark the subscription active, issue the plan's grants, write the invoice and payment, and emit `subscription.activated`.

Because the puller pays the fee, the customer needs USDC and no SOL.

**Spike S2 (2026-11-17): confirmed on devnet.** The bundle fits in one transaction with the puller as fee payer and rent payer; it costs the puller 0.00263636 SOL per new wallet. Milestone M2 repeated it for three wallets through the real checkout endpoints (20,653 to 35,653 compute units).

## Collecting each period

The settlement worker runs on a schedule and on demand. For each active subscription:

**At the start of a period**

1. Read the on-chain subscriber record. If it is cancelled or the authority is closed, update our state and stop.
2. Build the invoice: base fee, plus any overage accrued and not yet collected.
3. Pull the invoice total with `transferSubscription`.
4. On confirmation: mark the invoice paid, reset the period's grants, emit `subscription.renewed` and `payment.succeeded`.

**During a period (overage)**

1. Overage accrues in the `accruals` table as usage is tracked.
2. When accrued overage reaches the settlement threshold (default 5 USDC), or the period is about to end, pull it.
3. A pull that would pass the ceiling is reduced to what is left, and overage is then blocked for the rest of the period.

Collect accrued overage shortly before the period ends. A pull that lands after the boundary counts against the next period's ceiling.

**Sending transactions safely**

- Each attempt records its signature and the transaction's `lastValidBlockHeight`.
- Never send a second transaction for the same invoice until the first has either confirmed or its blockhash has expired. Otherwise both can land and the customer is charged twice.
- Treat `confirmed` as paid for entitlement purposes and re-check at `finalized`.
- Set a compute unit limit and a priority fee on every transaction.

## When a pull fails

| Cause | How we detect it | What we do |
| --- | --- | --- |
| Not enough USDC | Transfer error | `past_due`, retry on a schedule |
| Subscription cancelled | Subscriber record has an expiry | `canceling`, then `ended` at the expiry |
| Authority closed or delegation revoked | Account missing | `ended` at once |
| Token account frozen or closed | Transfer error | `past_due`, notify, no automatic retry |
| Plan sunset by the merchant | Plan status | Stop renewing, prompt the customer to move to the current version |

Retry schedule for `past_due`: after 1 hour, 6 hours, 24 hours and 72 hours. Entitlements stay on during this grace period and overage is blocked. After the last retry the subscription moves to `ended` and the customer falls back to the free plan. Every transition emits a webhook; sending email to the customer is the merchant's job.

Remember fact 7: a period that passes unpaid cannot be collected later. The grace period should therefore be shorter than the billing period.

## Reconciliation

Customers can act on-chain without going through us: cancel from another interface, close their authority, or move their funds. The reconciler keeps our records true.

- **Before every pull:** read the subscriber record and the plan.
- **On a schedule (every few minutes):** read the subscriber records of all active subscriptions and compare status, period start and amount pulled with ours.
- **Events:** the program emits `SubscriptionCreatedEvent`, `SubscriptionCancelledEvent`, `SubscriptionResumedEvent`, `SubscriptionTransferEvent` and `PlanUpdatedEvent` through self-CPI. Subscribing to these through an RPC provider's webhooks gives near real-time updates. This is an optimisation; polling is the source of truth for the first version.
- **Drift report:** a command that lists every difference between our records and the chain, like Autumn's `verify` endpoint does for Stripe.

**Verify (spike S3):** decoding the program's events from a transaction with the published IDL. Still open; M2 reconciles by polling only.

## How M2 implements this

Code: `packages/solana` (chain access) and `packages/settlement` (everything that decides). Settings come from the environment so short devnet plans can be exercised; the defaults follow this document.

| Topic | What the code does |
| --- | --- |
| Checkout | `attach` on a paid plan creates a `pending` subscription and a checkout session, and returns `/checkout/:id`. The page reads price, period and ceiling from the on-chain plan, connects a wallet through the Wallet Standard, and asks the server to build the transaction for that wallet. The server refuses up front if the wallet has no USDC account, too little USDC, or already has a subscription to the plan. The signed transaction must carry exactly the message bytes we built; then the puller co-signs and it is broadcast. |
| Recording before sending | Every money-moving transaction is a row in `settlement_attempts` with its signature and `last_valid_block_height`, written before it is broadcast. A partial unique index refuses a second `pending` attempt for one invoice. |
| Deciding an outcome | Confirmed or finalized: paid. Failed: classified (below). Unknown: still pending until the block height passes `last_valid_block_height`, then `expired`, and only then may a new transaction be signed. |
| Renewal | Once a period boundary is 60 seconds old (`NUMMO_BOUNDARY_MARGIN`), a renewal invoice is written: the base fee, plus overage that was never invoiced. Unpaid overage lines from the last period move onto it; an unpaid base fee does not (fact 7). |
| Overage | Accrued overage is invoiced once it reaches 5 USDC (`NUMMO_SETTLEMENT_THRESHOLD`), or whenever there is any and the period is within its close window (a tenth of the period, at most one hour). |
| Ceiling | Before each pull, the on-chain record says what the period still allows. A larger invoice is cut to that, the rest is written off with a negative line, and overage is blocked until the period ends. |
| Failures | SPL Token error 1 is `insufficient_funds`, 17 is `account_frozen`; program errors 508 (cancelled), 501 and 516 (plan ended) and 136 (stale authority) end the subscription; fee-payer and blockhash problems are `transient` and retried without touching the customer. Retries follow `NUMMO_RETRY_SCHEDULE` (default `1h,6h,24h,72h`, offsets from the first failure). A frozen account is not retried and ends when the grace period does. |
| Reconciler | Every two minutes, and before every pull, each live paid subscription's record and its wallet's Subscription Authority are read. A cancellation sets `cancel_at` and moves the subscription to `canceling`; a resume clears it; a missing record or an authority that was closed or re-created ends it. |
| Finality | `confirmed` counts as paid. Payments are re-checked until `finalized`; one whose transaction disappears is reverted and its invoice reopened. |
| `verify` | Read-only. Compares each published plan (amount, period, mint, puller listed, end time) and each live subscription (record exists, authority valid, wallet, terms, cancellation, period anchor, and the amount we recorded for the chain's current period against `amountPulledInPeriod`). |

Known gaps: rent sponsorship has no quota yet, so a plan with a zero base fee lets anyone with a checkout link make the puller pay rent for new records (the SDK README warns about this); and the checkout page has been driven in a browser with a test wallet but not yet by a real wallet extension. Some wallets add instructions to transactions they sign; the server refuses any change, so that needs checking per wallet.

## One-off purchases

A top-up bought by hand is a plain token transfer the customer signs, with no delegation. The checkout adds a unique reference key to the transfer instruction so the payment can be found and matched to the invoice, which is the convention Solana Pay uses. An MPP `charge` is an alternative for the same job and is worth trying in milestone M4.

## Plan changes

On Stripe, a server can upgrade a customer without their involvement. Here, any change that needs a different on-chain plan needs the customer's signature.

- **Upgrade:** one transaction that subscribes to the new plan, pulls the prorated difference as the first charge, and cancels the old subscription. The merchant co-signs so the old one ends immediately.
- **Downgrade:** takes effect at the period end. The customer signs the new subscription when prompted. If they do not, the old one is simply not renewed.
- **Merchant-side cancellation:** the merchant cannot cancel the on-chain record alone. We stop pulling, end the entitlements, and the portal prompts the customer to revoke the leftover record.
- **Refunds:** there is no pull-back. A refund is a transfer the merchant signs, which we prepare and record against the invoice.

## Key custody

The puller key signs every collection, so where it lives matters.

| Mode | Who holds the puller key | Notes |
| --- | --- | --- |
| Self-hosted | The merchant, in their own worker's environment | Simplest and fully non-custodial. The first version targets this. |
| Hosted | Our service, in a key management service, one key per merchant | The plan's `destinations` list limits what a leaked key can do: funds can only go to the merchant's wallets, and only up to each customer's ceiling. |

Under D3 a compromised puller key cannot redirect funds. Under the fallback design (recurring delegations) it could, up to each cap, because that kind of record has no destination list. This is the main reason to prefer D3.

A plan allows the owner plus up to four listed pullers (`MAX_PLAN_PULLERS`, confirmed in the program source). The merchant's main wallet should own the plan and receive funds, and a separate hot wallet should be the puller.

## Agent payments: x402 and MPP (milestone M4)

Both protocols return `402 Payment Required` with a price, and the client retries with a payment ([Solana guide](https://solana.com/docs/payments/agentic-payments)).

| | x402 | MPP |
| --- | --- | --- |
| Packages | `@x402/core`, `@x402/express`, `@x402/svm` | `@solana/pay-kit` |
| Fixed price per call | `exact` scheme | `charge` intent |
| Metered, cost unknown upfront | `upto` scheme, where the facilitator supports it | `session` intent: a payment channel with signed vouchers |
| Subscriptions | Not part of the protocol | `subscription` intent, backed by the same Subscriptions program |

What we add is a thin middleware around these libraries:

1. If the caller is a known customer with an active subscription and balance, serve the request and `track` it. No 402.
2. Otherwise return the protocol's 402 challenge.
3. When a payment succeeds, record it as a payment and a usage event against a customer keyed by the paying wallet.

That way a merchant sees subscribers and pay-per-call agents in one ledger and one dashboard. We do not run a facilitator.

## Tokens and networks

| | Devnet | Mainnet |
| --- | --- | --- |
| x402 network id | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

USDC first. Other stablecoins (USDG, PYUSD, USDT) are a config change at the program level, but each one needs testing, and Token-2022 mints with transfer hooks need the extra accounts the SDK resolves.

## Gotchas checklist

- Amounts are always base units. 5 USDC is `5_000_000n`.
- The merchant's receiving token account must exist before the first pull.
- The customer's token account must exist before the authority is created.
- Periods are hours. Do not show "monthly" in the interface for a 720-hour plan; say "every 30 days".
- A returning wallet must pass its real authority id, or `subscribe` fails with `StaleSubscriptionAuthority`.
- Plan updates carry the plan state seen at signing and fail with `StalePlanApproval` if it changed. Fetch, then update.
- Fixed and recurring delegations have a hard expiry with no grace period.
- One subscription per plan per wallet. A customer who needs two needs two wallets or two plans.
