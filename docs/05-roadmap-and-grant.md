# 05. Roadmap, grant strategy, risks

Durations below are estimates for one person working full time. They are for ordering the work, and are not commitments.

## Spikes first

Small throwaway experiments on devnet that settle the assumptions the design rests on. Do these before scaffolding anything.

| Spike | Question | How | If the answer is no |
| --- | --- | --- | --- |
| S1 | Can a puller make several partial pulls in one period, up to the plan amount? | Create a plan of 70 devnet USDC per 1 hour. Subscribe from a second wallet. Pull 20, then 5, then 5. Then try to pull 50 and expect a rejection. Wait for the next period and pull again. | Use the fallback in [03-solana-settlement.md](03-solana-settlement.md): a plan for the base fee plus a recurring delegation for overage. |
| S2 | Does the one-signature activation work with our puller as fee payer? | Build one transaction with create-authority, subscribe, and the first pull. Customer wallet signs, puller co-signs and pays. Record who pays rent for the new accounts and how much. | Split into two transactions, or have the customer pay the fee. |
| S3 | Can we read state and events reliably? | Fetch a subscriber record and decode its fields. Cancel from the customer wallet and see the change. Decode the program's events from a transaction using the published IDL. | Rely on polling account state only. |

Also confirm during the spikes: the maximum number of pullers on a plan, and the behaviour of a pull that lands just after a period boundary.

Estimated time: 2 to 3 days.

## Milestones

### M1. Ledger core, no chain (about 2 weeks)

Build:
- Monorepo scaffold, database schema, migrations.
- Config builders and validation, and `PUT /v1/config`.
- `packages/core`: deduction order, credit systems, reservations, period resets.
- API: `check`, `track`, `track/batch`, `balances/finalize`, customer reads.
- SDK with fail-open behaviour.
- Free plans working end to end.

Done when:
- The demo app gates a feature on a free plan and blocks at zero.
- Property tests pass for the ledger rules in [02-architecture.md](02-architecture.md).
- A concurrency test with 100 parallel `track` calls on one customer never oversells.

### M2. Settlement on devnet (about 2 weeks)

Build:
- `packages/solana`: publish a plan, build the activation transaction, pull, read accounts.
- Checkout page with wallet connect.
- Settlement worker: period renewals, overage accrual and threshold collection, safe resend.
- Failed-payment state machine and retries.
- Reconciler by polling, and `bill verify`.
- Webhook outbox and dispatcher.

Done when:
- A wallet subscribes to Pro with one signature and no SOL.
- Renewal, overage collection, cancellation and a failed payment all behave as described, on a plan with a short period.
- `bill verify` reports no drift after each scenario.

### M3. Product surface and mainnet (about 2 weeks)

Build:
- Merchant dashboard: customers, plans, usage, payments.
- Customer portal: plan, ceiling, usage, receipts, cancel.
- Top-ups, one-off and automatic.
- Upgrades and downgrades with proration.
- CLI polish, documentation site, quickstart.
- Mainnet configuration and a hosted demo.

Done when:
- A stranger can follow the quickstart and charge a devnet wallet in under 30 minutes.
- The demo runs on mainnet with real USDC at small amounts.
- The repository is public with a licence, a README and a recorded walkthrough.

### M4. Agents and design partners (about 2 weeks)

Build:
- x402 and MPP middleware that feeds the ledger.
- Per-model token pricing for AI credit systems.
- Whatever the first design partners need most.

Done when:
- An agent script pays the demo API per request and shows up in the dashboard next to subscribers.
- Two or three real projects are integrated, at least on devnet.

## Testing approach

| Layer | Method |
| --- | --- |
| Ledger rules | Property tests with fast-check: for any sequence of grants, usage, locks and resets, the balance equals grants minus usage, never goes negative without overage, and replaying the same idempotency key changes nothing. |
| Concurrency | Parallel requests against a real Postgres. |
| Settlement | Integration tests against Surfpool with the Subscriptions program loaded, using short periods. |
| End to end | Scripted scenarios on devnet: subscribe, renew, overage, cancel, fail, recover. |
| Money maths | Table-driven tests for proration and rounding. Overage rounds up to the next base unit per invoice line. |

## Grant strategy

### Status on 2026-11-16

- **Superteam India, Solana Foundation India Grants:** the listing shows "Applications Paused". A third-party tracker reports all 21 regional listings paused since about April or May 2026 with no restart date. Check the [listing](https://superteam.fun/earn/grants/solana-foundation-india-grants) before each planning decision.
- **Solana Foundation grants, applied for directly:** open, reviewed on a rolling basis, about four weeks to a decision. No published maximum.
- **Colosseum hackathons:** the autumn 2026 events have closed. Watch [colosseum.com](https://colosseum.com/) for the next one.

### What reviewers look for

The India listing's own heuristics: proof of work over potential, working links over ideas, product feedback over market thesis, working product over prototype over documents. It asks for open source soon after mainnet, and gives priority to Superteam India members with a reputation score.

The Solana Foundation's criteria: a public good, open source, a reason it is only possible on Solana, and a clear use of funds with milestones.

### How this project answers them

| Criterion | Our answer |
| --- | --- |
| Public good | An open-source billing layer any Solana team can self-host. The first reusable implementation of usage billing on the Foundation's own Subscriptions program. |
| Only possible on Solana | It depends on the native Subscriptions program, sub-cent fees that make threshold settlement practical, and fast finality. |
| Named focus area | The India listing names payments and stablecoins, and internet-native monetisation via x402, as focus areas. Developer tooling is another. This project is all three. |
| Real-world use | It brings non-crypto businesses (AI startups) onto stablecoin rails for the pricing model they already use. |
| Proof of work | A working devnet demo, a public repository, and design partners. This is what we must have before applying. |

### Sequence

1. Finish the spikes and M1, then M2. Apply only once a wallet can be charged on devnet in a recorded demo.
2. Apply to the Solana Foundation directly with M3 and M4 as the funded milestones.
3. In parallel, build Superteam reputation through bounties on Superteam Earn, so an application is strong if the India listing reopens.
4. Post progress publicly each week. Both programmes ask for regular updates, and it is the cheapest proof of work.
5. Talk to five to ten usage-priced Solana API teams early. Their feedback is the "product feedback over market thesis" evidence, and two or three of them become design partners.

### Draft milestone budget

A starting point for a 10,000 USD request. Adjust to the programme's rules.

| Tranche | Deliverable | Share |
| --- | --- | --- |
| 1 | M3 complete: mainnet, dashboard, portal, docs, public repository | 40% |
| 2 | M4 complete: x402 and MPP adapter, per-model pricing | 30% |
| 3 | Three live integrations and a written report on what was learned | 30% |

## Risks

| Risk | Likelihood | What we do about it |
| --- | --- | --- |
| Partial pulls do not work as assumed (S1) | Low | Spike first. Fallback design is ready. |
| The Subscriptions program changes in a breaking way | Low to medium | Pin SDK versions. Records carry a version field and the program documents a migration path. Keep on-chain code behind one package. |
| An incumbent adds a stablecoin rail | Medium | Be the open-source default on Solana early. Stay close to the Foundation's primitives. Accept that this may remain a public good. |
| Little demand from AI startups today | High | Start with Solana-native API companies that already bill in stablecoins. |
| The India grant stays paused | Unknown | Apply to the Foundation directly. Use hackathons. |
| Puller key compromise in hosted mode | Medium impact | Destination allowlists, a separate hot puller wallet, key management service, self-host as the default. |
| Customers charged twice by a resend bug | High impact | The blockhash-expiry rule in [03-solana-settlement.md](03-solana-settlement.md), plus the on-chain ceiling as a backstop. |
| Regulation | Unclear | Stay non-custodial software. Indian merchants receiving stablecoins face the VDA tax regime (30% on gains, 1% TDS), so target merchants outside India first. This is not legal advice; get a professional opinion before running a hosted service that touches funds. |

## Open questions

1. **Licence.** Decided on 2026-11-17: Apache-2.0, as recommended (Polar uses it, and it includes a patent grant).
2. **Name.** `bill` is a working name.
3. **Hosted or self-host first.** The plan assumes self-host first with a hosted demo. A hosted service raises the key custody and regulatory questions above.
4. **Settlement threshold default.** 5 USDC is a guess. Ask design partners.
5. **Grace period default.** 72 hours is a guess, and it must stay shorter than the billing period.
6. **Customer-chosen caps.** Whether to support recurring delegations so a customer can set their own on-chain limit.
7. **Which stablecoins after USDC.**
8. **Embedded wallets.** Whether the checkout should offer an embedded wallet for customers who have none. Dynamic is integrating the Subscriptions program and is the obvious candidate.
9. **How we charge, if this becomes a business.** A flat SaaS fee fits the non-custodial design better than a percentage of volume.
