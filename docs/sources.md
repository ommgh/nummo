# Sources

All accessed on 2026-11-16. Primary sources are the project's or organisation's own pages. Secondary sources are third-party write-ups; treat their numbers as leads to re-check, not as facts.

## Product references

| Source | Type | What it supports |
| --- | --- | --- |
| [Autumn home page](https://useautumn.com/) | Primary | Feature list, positioning as a real-time system of record, the `check` under 50 ms claim, customer quotes. |
| [Autumn docs: welcome](https://docs.useautumn.com/welcome) | Primary | The table of what a team would otherwise build; how Autumn differs from post-hoc invoicing tools; fail-open default. |
| [Autumn docs index](https://docs.useautumn.com/llms.txt) | Primary | Full list of concepts and endpoints. The best map of scope. |
| [Autumn docs: balances](https://docs.useautumn.com/documentation/concepts/balances) | Primary | Balance fields, stacking, the breakdown array, and deduction order. |
| [Autumn docs: balance locking](https://docs.useautumn.com/documentation/customers/balance-locking) | Primary | The check-with-lock, do work, finalize flow. |
| [Autumn docs: credit systems](https://docs.useautumn.com/documentation/modelling-pricing/credit-systems) | Primary | Credit schemas, rate cards, direct balances used before credits, per-model AI credits. |
| [Polar field guide](https://polar.sh/field-guide) | Primary | Events as immutable facts, meters as reducers, credits derived from grant and usage events, guardrails, billing as code, bring your own PSP. |
| [Polar on GitHub](https://github.com/polarsource/polar) | Primary | Apache-2.0 licence, feature summary, pricing. |
| [Lago: self-hosted billing](https://getlago.com/blog/self-hosted-billing) | Primary | AGPL-3.0 licence; event deduplication by transaction id. Do not copy code from Lago. |

Note: Autumn's site says "open source core, self-host ready". Its main repository returned a 404 when fetched during research, so its licence is unconfirmed. Its TypeScript SDK repository is MIT.

## Solana payment primitives

| Source | Type | What it supports |
| --- | --- | --- |
| [Solana: native Subscriptions and Allowances announcement](https://solana.com/news/subscriptions-and-allowances) | Primary | Launch on 2026-06-02; three models; design partners including Helius; audit; pay.sh subscription support. |
| [Subscriptions docs: overview](https://solana.com/docs/payments/subscriptions/overview) | Primary | Program ID, the Subscription Authority, supported tokens, the list of on-chain events, versioning. |
| [Subscriptions docs: subscription plan](https://solana.com/docs/payments/subscriptions/subscription-plan) | Primary | `createPlan`, `subscribe`, `transferSubscription`, cancel, resume; immutable terms; pullers and destinations; `UNKNOWN_INIT_ID`. |
| [Subscriptions docs: recurring delegation](https://solana.com/docs/payments/subscriptions/recurring-delegation) | Primary | User-defined per-period allowance; hard expiry; delegatee signs transfers. |
| [Subscriptions docs: fixed delegation](https://solana.com/docs/payments/subscriptions/fixed-delegation) | Primary | Fixed total allowance. |
| [solana-program/subscriptions](https://github.com/solana-program/subscriptions) | Primary | Program source and audit directory. Read this during spike S1. |
| [pay.sh subscriptions: protocol and internals](https://pay.sh/docs/building-with-pay/subscriptions/protocol) | Primary | The one-transaction activation, server-driven renewal, missed periods not accumulating, cancellation behaviour, the 402 challenge format. |
| [pay.sh](https://pay.sh/) | Primary | What the Foundation's API gateway does, and the catalogue of providers that are candidate first users. |
| [Solana docs: agentic payments](https://solana.com/docs/payments/agentic-payments) | Primary | MPP and x402 compared. |
| [Solana docs: MPP](https://solana.com/docs/payments/agentic-payments/mpp) | Primary | `charge` and `session` intents, `@solana/pay-kit`, production verification list. |
| [Solana docs: x402](https://solana.com/docs/payments/agentic-payments/x402) | Primary | V2 headers, network identifiers, `exact` and `upto`, packages, devnet USDC mint, verification requirements. |
| [Chainstack: Solana subscriptions and allowances](https://docs.chainstack.com/docs/solana-subscriptions-and-allowances) | Secondary | Summary table of the three models; the claim of up to four whitelisted pullers. Verify against the program source. |

## Landscape

| Source | Type | What it supports |
| --- | --- | --- |
| [Tributary on GitHub](https://github.com/tributary-so/tributary) | Primary | A separate Solana program with subscription, milestone and pay-as-you-go policies; MIT; about 1,500 commits; last commit 2026-09-28. |
| [Stripe: stablecoin payments for subscriptions](https://stripe.com/blog/introducing-stablecoin-payments-for-subscriptions) | Primary | Stripe's stablecoin subscription launch. |
| [Eco: best stablecoin subscription billing APIs in 2026](https://eco.com/support/en/articles/15182323-best-stablecoin-subscription-billing-apis-in-2026) | Secondary | Comparison of ten providers; Stripe's 1.5% rate and chain list; Loop joining Lead Bank; Helio acquired by MoonPay; Sphere Pay on Solana. |
| [CryptoContent: x402 and agentic payments statistics](https://cryptocontent.dev/x402-agentic-payments-statistics.html) | Secondary | Countries in Stripe's published stablecoin terms. |
| [ZeroClick FAQ](https://zeroclick.ai/faq) | Primary | Five billing modes for agents, settling on Base and Tempo plus cards. |
| [Second Breakfast: agentic commerce](https://www.second-breakfast.co/blog/agentic-commerce-pt1) | Secondary | The estimate of about 0.9M USD a month of real x402 plus MPP volume. One analyst's method. |
| [Cambrian: agentic finance landscape, Q3 2026](https://x.com/CambrianNetwork/status/2107505199686332736) | Secondary | Cumulative x402 and MPP transaction counts. |

## Grants and funding

| Source | Type | What it supports |
| --- | --- | --- |
| [Superteam Earn: Solana Foundation India Grants](https://superteam.fun/earn/grants/solana-foundation-india-grants) | Primary | "Applications Paused"; up to 10k USDG; average 4,822 USD; 127 recipients; evaluation heuristics; focus areas; open-source requirement. |
| [web3grant: Superteam grants paused](https://www.web3grant.com/guides/superteam-grants) | Secondary | All 21 regional listings paused, likely since April or May 2026; list of open Solana programmes. |
| [Solana Foundation grants and funding](https://solana.org/grants) | Primary | Evaluation criteria, rolling review, timeline, standard and convertible grants. |
| [Colosseum: Crypto World's Fair](https://colosseum.com/worldsfair) | Primary | Submissions closed on 2026-10-12. |

## Regulation

| Source | Type | What it supports |
| --- | --- | --- |
| [Crypto Times: India parliament panel on crypto regulation](https://www.cryptotimes.io/2026/07/24/india-parliament-panel-urges-phased-crypto-regulation-under-sebi-or-rbi/) | Secondary | India's tax regime for virtual digital assets: 30% on gains, 1% TDS on transfers. Not legal advice. |

## Not yet read, worth reading before building

- The Subscriptions program source and its tests, for exact pull accounting.
- [draft-solana-subscription](https://datatracker.ietf.org/doc/draft-solana-subscription/), the MPP subscription intent on Solana.
- [x402 `upto` scheme on Solana](https://www.npmjs.com/package/@x402/svm), which the package notes describe as implemented through payment channels.
- [Kora](https://solana.com/docs/tools/kora/guides/x402), the Foundation's fee sponsorship service, as an alternative to paying fees from the puller wallet.
- Autumn's docs on [plan versioning](https://docs.useautumn.com/documentation/customers/versioning) and [proration](https://docs.useautumn.com/documentation/modelling-pricing/proration), before building upgrades in M3.
