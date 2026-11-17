# 01. Product

## The problem

Usage-based pricing is how AI products charge: included credits, per-token overage, top-ups, spend caps. Building that takes far more than a checkout. Autumn's docs list what a team ends up writing: subscriptions, a credit ledger with real-time enforcement, entitlements, spend caps and auto top-ups, plan versioning, and the edge cases around plan changes and failed payments ([Autumn docs](https://docs.useautumn.com/welcome)).

On card rails that problem is solved by Autumn, Polar, Lago and others, all sitting on a processor such as Stripe.

On Solana, the payment rail now exists but the layer above it does not:

- The [Subscriptions and Allowances program](https://solana.com/news/subscriptions-and-allowances) lets a wallet authorise recurring pulls. It knows nothing about features, usage, credits or what a customer is entitled to.
- [x402](https://solana.com/docs/payments/agentic-payments/x402) and [MPP](https://solana.com/docs/payments/agentic-payments/mpp) let a client pay per HTTP request. They hold no customer state between requests beyond a payment session.

A merchant who wants "$20 a month in USDC, 1,000 credits included, overage capped at $50" has to write the whole stateful layer themselves. Helius, a large Solana infrastructure provider, is integrating the Subscriptions program directly, which shows the demand and also that today each team builds it in-house.

## Who it is for

First users, in order of how reachable they are:

1. **Solana-native API and infrastructure companies** that already price by usage and whose customers already hold stablecoins: RPC providers, data APIs, indexers. Many of them are listed on [pay.sh](https://pay.sh/).
2. **AI startups with crypto-native or global customers**, where cards fail or are unavailable and a wallet payment is the easier path.
3. **Teams selling to AI agents**, which cannot hold a card but can hold a wallet.

The second and third groups are the story for the grant. The first group is where real usage will come from first.

## What we build

One sentence: an open-source system of record for plans, balances and usage, which settles in stablecoins on Solana.

Capabilities, in priority order:

1. **Pricing as config.** Features and plans are declared in a TypeScript file and applied with a CLI. A price change is a new plan version; existing customers keep the version they signed.
2. **Real-time checks.** `check` answers whether a customer may use a feature, from the current balance, in one call.
3. **Usage tracking.** `track` records a usage event and deducts from the right grants in the right order. It is idempotent.
4. **Reservations.** Hold balance before a long operation such as an LLM completion, then confirm the real amount afterwards.
5. **Credit systems.** One balance that several features draw from at different rates, including per-model token pricing.
6. **Subscriptions in USDC.** A hosted checkout where the customer signs once. After that the settlement worker collects each period without further signatures.
7. **Overage with an on-chain ceiling.** Usage past the included amount is billed per unit. The most that can ever be pulled in a period is fixed in the on-chain plan the customer signed.
8. **Top-ups.** One-off credit purchases, and automatic refills when the balance runs low.
9. **Failed payment handling.** Retries, a grace period, then downgrade of entitlements, with webhooks at each step.
10. **Customer portal.** The customer sees their plan, usage, receipts with transaction signatures, and can cancel.
11. **Agent payments (later milestone).** An x402 and MPP adapter so a request paid per call feeds the same ledger.

## What crypto adds over the card version

These are the reasons to use this instead of Autumn plus Stripe, and they belong in the pitch.

- **The spend cap is enforced by the chain.** The customer signs a plan whose ceiling is public and immutable. The merchant cannot pull more, whatever our software does. Card billing has no equivalent.
- **Non-custodial.** Money goes from the customer's token account to the merchant's. `nummo` never holds funds.
- **Frequent settlement is nearly free.** Fees are a fraction of a cent, so overage can be collected at a small threshold (for example every $5 accrued) instead of once a month. The merchant's credit exposure is bounded by the threshold.
- **No chargebacks, immediate finality.** Settlement is final within seconds.
- **One ledger for people and agents.** A wallet is the identity in both cases.
- **Public receipts.** Every charge has a transaction signature anyone can verify.

## What we do not build

- **A new on-chain program.** We use the Foundation's.
- **A payment protocol or facilitator.** We use x402 and MPP libraries as they are.
- **Fiat off-ramping.** The merchant receives stablecoins. Converting to bank money is their choice of provider.
- **Tax calculation and filing.** There is no Stripe Tax equivalent here. We store what is needed for the merchant's accountant and stop there.
- **Custody or wallets.** Customers bring a wallet (or an embedded wallet the merchant provides).
- **Other chains.** Solana only. The settlement code sits behind a narrow interface, but we do no work to support another rail.
- **Enterprise invoicing features** such as net terms, credit notes and multi-phase schedules. Autumn has these; they are out of scope for the first version.

## Pricing models supported in the first version

| Model | Example | In v1 |
| --- | --- | --- |
| Free plan with limits | 100 messages a month, no wallet needed | Yes |
| Flat subscription | 20 USDC every 30 days | Yes |
| Included usage plus overage | 1,000 credits included, then 0.01 USDC each, capped at 50 USDC | Yes |
| Prepaid credits, one-off | Buy 10 USDC of credits | Yes |
| Automatic top-up | Refill 10 USDC when below 2 USDC, at most 100 USDC a period | Yes |
| Credit system with rates | Premium message costs 10 credits, basic costs 1 | Yes |
| Per-model token pricing | Provider cost plus a markup | Later |
| Seats | 5 USDC per seat, prorated | Later |
| Rollovers | Unused credits carry over, up to a limit | Later |
| Pay per request by agents | 0.001 USDC per call over x402 | Milestone M4 |
| Custom contracts | One-off plan for a large customer | Later |

## Landscape

Checked on 2026-11-16. Sources are in [sources.md](sources.md).

| Product | What it does | Why it is not this product |
| --- | --- | --- |
| [Solana Subscriptions program](https://solana.com/docs/payments/subscriptions/overview) | On-chain recurring pulls and allowances. Audited, open source. | A primitive. No features, usage, credits, or entitlements. We build on it. |
| [pay.sh](https://pay.sh/) | Gateway that puts an API behind per-call or flat subscription payment, aimed at agents. | Gates requests by payment. Does not model plans with included usage, credits, or overage. |
| [Tributary](https://github.com/tributary-so/tributary) | Its own Solana program with subscription, milestone and pay-as-you-go policies, plus SDK and checkout. MIT. | A payment protocol with its own program, not a billing ledger. The closest neighbour; worth watching. |
| Sphere Pay | Solana subscriptions from a dashboard and API. Closed source. | Subscriptions only, as far as public material shows. |
| Stripe stablecoin subscriptions | Stablecoin payments inside Stripe Billing at 1.5%, including Solana. | Custodial, settles to fiat, and merchant availability is limited to a set of countries that does not include India. |
| Autumn, Polar, Lago | The same billing layer on card rails. | No stablecoin rail. Polar advertises "bring your own PSP", so they could add one. See risks. |
| ZeroClick | Storefront for selling to agents with five billing modes. | Settles on Base and Tempo, plus cards. |

I found no product that ships credits, entitlements and metered overage on Solana rails. That is a statement about my search, and a new entrant could appear at any time.

## Honest positioning

- Real volume on agent payment protocols is small today. One analyst estimates about 0.9M USD a month across x402 and MPP after removing wash activity.
- Most AI startups' customers still pay by card.
- The moat is thin: an incumbent can add a stablecoin processor.

So the plan is to make this a credible open-source public good first, win a grant and a few design partners with it, and decide about a business afterwards.
