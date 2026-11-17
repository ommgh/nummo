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
- Reconciler by polling, and `nummo verify`.
- Webhook outbox and dispatcher.

Done when:
- A wallet subscribes to Pro with one signature and no SOL.
- Renewal, overage collection, cancellation and a failed payment all behave as described, on a plan with a short period.
- `nummo verify` reports no drift after each scenario.

#### M2 results (2026-11-17)

Built: `packages/solana` (the `Chain` interface, `SolanaChain` over `@solana/kit`, and an in-memory `FakeChain` that follows the program's rules), `packages/settlement` (checkout, settlement worker, failed-payment state machine, reconciler, `verify`, webhook dispatcher), `apps/worker`, `packages/cli` (`push`, `plans`, `plans publish`, `verify`, `customers get`), the hosted checkout page, and `e2e/devnet.ts`.

All three done-when criteria were met on devnet by `e2e/devnet.ts`, on a plan of 2 USDC per hour with overage capped at 5 USDC (ceiling 7):

| Scenario | Result |
| --- | --- |
| Activation | Three wallets holding USDC and no SOL each signed once. The puller paid fees and rent, 0.00263636 SOL per activation; the activation used 20,653 to 35,653 compute units. |
| Overage | 1.50 USDC accrued past the 1 USDC threshold and was pulled in one transaction (about 6,100 compute units). |
| Failed payment | A wallet with 0.50 USDC owing 1.50 went `past_due` (SPL Token error 1, classified `insufficient_funds`), overage was blocked, three retries failed on schedule, and the customer fell back to the free plan. |
| Cancellation | `cancelSubscription` signed outside nummo; `verify` reported the drift, the reconciler moved the subscription to `canceling` with the on-chain end time, and `verify` was clean again. |
| Webhooks | 24 events delivered with valid `X-Nummo-Signature` headers. |
| Checkout page | Driven in Chrome against devnet (`e2e/checkout-page.ts`) with a test wallet registered through the Wallet Standard events: the page listed it beside the installed Backpack extension, connected, had it sign, submitted, and redirected to the success URL. The activation landed and `verify` was clean. |
| Renewal | One settlement pass after the 1-hour boundary pulled 2 USDC from alice; the on-chain period advanced to the start we computed, with 2 USDC counted in it, and her credits reset to 100. Carol's cancelled subscription ended at the period end with no pull, and she fell back to the free plan. |
| `nummo verify` | No drift after each scenario (one expected notice: an ended subscription's on-chain record stays open). |

Differences from the plan, decided during the build:

- **Checkout lives in the API** as one server-rendered page (`/checkout/:id`) using the Wallet Standard's window events, with no bundler. The Next.js web app arrives with the dashboard and portal in M3.
- **Jobs are three loops with Postgres advisory locks**, not pg-boss. Nothing yet needs a queue; two workers can run safely.
- **Settlement tests use `FakeChain` against real Postgres**, plus the scripted devnet run, instead of Surfpool, which is not installed here. `FakeChain` is pinned to the S1 observations by a unit test.
- **Test databases are separate:** the db suite uses `nummo_test` and the devnet script `nummo_e2e`, because a worker settles every org in an environment.

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

#### M3 results (2026-11-17)

Built: plan changes with proration and scheduled downgrades (`packages/core/src/billing.ts`, `packages/db/src/billing.ts`), one-off and automatic top-ups, the customer portal (`packages/settlement/src/portal.ts`, `apps/api/src/portal-page.ts`), the merchant dashboard with browser-wallet plan publishing (`apps/api/src/dashboard.ts`), `preview`, `topUp`, `portal` and `customers.list` in the SDK and API, CLI commands (`login`, `init`, `wallet new`/`balance`, `customers list`, `preview`, `attach`, `portal`, `whoami`), a Dockerfile and compose services, mainnet settings, and the [guide](guide/README.md) with a quickstart.

`e2e/devnet-m3.ts` passed every check on devnet in 57 seconds (2026-11-17):

| Scenario | Result |
| --- | --- |
| Dashboard publishing | The merchant wallet signed `createPlan` built by the dashboard; the server sent it and registered `pro@1` after the on-chain checks. |
| Upgrade | Five seconds into an hourly Pro period (2 USDC), one signature subscribed to Team (5 USDC), pulled 3.00481 USDC (5 less a 1.99519 credit) and cancelled Pro on-chain. Pro stopped granting at once; Team granted 500 credits. |
| Old plan's overage | The 0.50 USDC of overage used on Pro before the change was pulled from Pro on the next settlement pass. |
| Downgrade | Team to Pro was scheduled for the period end; attaching Team again cancelled it. |
| One-off top-up | 3 USDC moved by plain transfer for 300 credits; the reference key is in the transaction's accounts; the customer held no SOL. |
| Automatic top-up | Usage took Refill credits from 10 to 3 (threshold 5); the next pass pulled 1 USDC and granted 100. |
| Portal | Cancel and resume, each signed by the customer's wallet and confirmed; the subscription went `canceling` and back to `active`. |
| `nummo verify` | No drift after every step. The puller spent 0.0068 SOL in all (three new subscriber records, fees). |

The dashboard, portal and top-up checkout were also checked in Chrome against that devnet data; the portal listed the installed Backpack wallet through the Wallet Standard. Tests: 142 (unit and db), including `packages/settlement/test/m3.db.test.ts` and the M3 HTTP routes in `apps/api/test`.

Done-when status:

| Criterion | Status |
| --- | --- |
| A stranger charges a devnet wallet in under 30 minutes | The [quickstart](guide/quickstart.md) is written and its CLI steps were run on a fresh database; the on-chain steps are the ones `e2e/devnet-m3.ts` exercises. Not yet tried by someone new. |
| The demo runs on mainnet with real USDC at small amounts | Not done. The code is ready (live keys, mainnet USDC by default, priority fee, the checklist in [deploy.md](guide/deploy.md)); it needs a funded mainnet puller, a merchant wallet and a hosting decision. |
| Public repository with a licence, a README and a recorded walkthrough | Licence and README done. Making the repository public and recording the walkthrough with a real wallet are still to do. |

Differences from the plan, decided during the build:

- **No Next.js app.** The portal and dashboard are server-rendered by the API like the M2 checkout, with no bundler.
- **Upgrades cancel at period end on-chain.** `cancelSubscriptionNow` needs the merchant's key, so the old subscription is cancelled by the customer in the same transaction and winds down: no entitlements, overage still collected, never renewed.
- **Downgrades to a paid plan are signed at the period end**, because a subscription's periods start when it is signed.
- **No documentation site yet.** The guide is Markdown in `docs/guide`, readable on GitHub; a hosted site can come with the public repository.

### M4. Agents and design partners (about 2 weeks)

Build:
- x402 and MPP middleware that feeds the ledger.
- Per-model token pricing for AI credit systems.
- Whatever the first design partners need most.

Done when:
- An agent script pays the demo API per request and shows up in the dashboard next to subscribers.
- Two or three real projects are integrated, at least on devnet.

#### M4 results (2026-11-18)

Built: `payPerUse` and `models` in the pricing config (`packages/config`); paid-request recording and token tracking in the ledger (`packages/db/src/agents.ts`); `packages/agents`, which runs Solana's `@solana/pay-kit` inside the API with the puller as fee payer and a Postgres replay store; `POST /v1/pay`, `/v1/track/tokens` and `/v1/check/tokens`; `paywall` (Hono middleware, fetch wrapper, or plain `check`), `trackTokens` and `checkTokens` in the SDK; the demo's `/agent/chat` and `/api/complete` routes and the agent script `apps/demo/src/agent.ts`; agent payments in the dashboard (payment kind and protocol, "Agent" customers, agent payments on the overview); `e2e/devnet-m4.ts`.

`e2e/devnet-m4.ts` passed every check on devnet in 22 seconds (2026-11-18), with real devnet USDC from Circle's faucet:

| Scenario | Result |
| --- | --- |
| 402 | An unpaid call to the demo's `/agent/chat` got a 402 with both an x402 `exact` offer (`PAYMENT-REQUIRED`, 0.01 USDC to the merchant) and an MPP `charge` challenge (`WWW-Authenticate: Payment`). |
| Agent pays | The agent script paid four calls, alternating x402 and MPP, from a wallet holding USDC and no SOL. Each answered 200 with a receipt header in 1.2 to 2.9 seconds; the merchant received 0.04 USDC; the puller spent 0.00004 SOL in fees. |
| Ledger | Four paid `pay_per_use` invoices, payments tagged `x402` and `mpp` with the paying wallet, each signature a successful devnet transaction, under customer `wallet:<agent>` with no plan. |
| Replay | A captured x402 payment and a captured MPP credential, sent again, each got a new 402; nothing was recorded twice. |
| Next to subscribers | A signed-in user with free-plan credits was served from them with no 402; the dashboard overview counted the agent's payments and listed the agent beside the user. |
| Tokens | A model call on `/api/complete` was charged 0.0414 credits for 15 input and 20 output tokens at Sonnet's derived rates. |

Tests: 156 (unit and db), including `apps/api/test/agents.db.test.ts` (paywall through Hono with a stand-in payment gate, replays, fail-open, header filtering, token pricing) and the config tests for `payPerUse` and `models`.

Done-when status:

| Criterion | Status |
| --- | --- |
| An agent script pays the demo API per request and shows up in the dashboard next to subscribers | Done on devnet (above). |
| Two or three real projects integrated, at least on devnet | Not started: needs design partners. |

Differences from the plan, decided during the build:

- **pay-kit, not the bare x402 packages.** `@solana/pay-kit` serves x402 and MPP behind one call over web `Request`s, so one middleware covers both protocols.
- **The payment runs in the nummo API, not the merchant's app.** The puller key stays in one place and the SDK has no chain dependencies; the app forwards only payment headers.
- **Per-model pricing compiles to the existing ledger.** Each model's token kinds become metered features with credit rates, so overage, top-ups, locks and the dashboard work unchanged.
- **Paid requests draw on no balance.** A request paid on the spot is recorded as usage that was paid for, so it never eats the payer's plan credits.

## Testing approach

| Layer | Method |
| --- | --- |
| Ledger rules | Property tests with fast-check: for any sequence of grants, usage, locks and resets, the balance equals grants minus usage, never goes negative without overage, and replaying the same idempotency key changes nothing. |
| Concurrency | Parallel requests against a real Postgres. |
| Settlement | Integration tests against real Postgres with `FakeChain`, which follows the program's rules (`packages/settlement/test`). Surfpool with the program loaded is the next step up. |
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
2. **Name.** Decided on 2026-11-17: `nummo` (the working name was `bill`).
3. **Hosted or self-host first.** The plan assumes self-host first with a hosted demo. A hosted service raises the key custody and regulatory questions above.
4. **Settlement threshold default.** 5 USDC is a guess. Ask design partners.
5. **Grace period default.** 72 hours is a guess, and it must stay shorter than the billing period.
6. **Customer-chosen caps.** Whether to support recurring delegations so a customer can set their own on-chain limit.
7. **Which stablecoins after USDC.**
8. **Embedded wallets.** Whether the checkout should offer an embedded wallet for customers who have none. Dynamic is integrating the Subscriptions program and is the obvious candidate.
9. **How we charge, if this becomes a business.** A flat SaaS fee fits the non-custodial design better than a percentage of volume.
