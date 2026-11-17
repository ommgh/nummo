# nummo: usage-based billing on Solana stablecoin rails

Name: `nummo` (decided 2026-11-17; the working name was `bill`). Last updated: 2026-11-17. Status: milestones M1 (ledger core) and M2 (settlement on devnet) built; M3 (product surface) built and passed on devnet, with its mainnet run, public repository and recorded walkthrough still to do. See the repository [README](../README.md). Spikes S1 and S2 passed on devnet. To use nummo, start with the [guide](guide/README.md).

## Summary

`nummo` is an open-source billing and entitlements layer for businesses that charge by usage (AI tokens, API calls, credits) and want to accept stablecoins on Solana.

It does for Solana what [Autumn](https://useautumn.com/) does for Stripe. The merchant's app asks `nummo` two questions on every request: "may this customer do this?" (`check`) and "they just did this much" (`track`). `nummo` keeps the plans, credit balances, and usage ledger, and it collects what is owed by pulling USDC from the customer's wallet through Solana's native Subscriptions program.

We do not write a new on-chain program. Solana shipped an audited one in June 2026, and the payment protocols for agents (x402 and MPP) already exist. The missing piece is the stateful layer on top of them, and that is what we build.

## Decisions made

| # | Decision | Why |
| --- | --- | --- |
| D1 | Build the off-chain billing layer only. No new on-chain program. | The Foundation's Subscriptions program is audited and already integrated by Helius and others. A competing program would be redundant and would need its own audit. |
| D2 | Solana only, USDC first. | Grant fit, and the Subscriptions program exists only there. |
| D3 | One on-chain Subscription Plan per plan version, with its amount set to the period ceiling (base fee plus maximum overage). Collect by partial pulls. | One primitive covers flat, hybrid and pay-as-you-go pricing. Depends on spike S1 in [05-roadmap-and-grant.md](05-roadmap-and-grant.md). |
| D4 | Non-custodial. Funds move from the customer's wallet straight to the merchant's wallet. | Lower regulatory exposure, and it is the honest crypto-native design. |
| D5 | Open source, self-hostable, TypeScript. | Required by every Solana grant route, and matches the SDKs we depend on. |
| D6 | Write a small core of our own. Use Polar and Autumn as design references, not as a fork. | Both are built around card processors. The parts we need are the data model and the rules, which are small. |

Licence: Apache-2.0 (decided 2026-11-17). Still open: who holds the key that signs pulls in a hosted deployment. See the open questions in [05-roadmap-and-grant.md](05-roadmap-and-grant.md).

## Read in this order

1. [01-product.md](01-product.md): the problem, who it is for, what we build and what we leave out, and the competitive landscape.
2. [02-architecture.md](02-architecture.md): components, stack, repository layout, data model, and the ledger rules.
3. [03-solana-settlement.md](03-solana-settlement.md): how money moves on-chain, the settlement worker, failure handling, and key custody.
4. [04-api-and-config.md](04-api-and-config.md): the pricing config file, the SDK, REST endpoints, and webhooks.
5. [05-roadmap-and-grant.md](05-roadmap-and-grant.md): spikes, milestones, testing, grant strategy, risks, and open questions.
6. [sources.md](sources.md): every source the plan relies on, with what each one supports.

The [guide](guide/README.md) is for people using nummo: quickstart, pricing config, billing flows, self-hosting and mainnet.

## Start here next session

1. Finish M3's done-when items, each of which needs the owner's decision or hands: make the repository public; run the demo on mainnet with real USDC at small amounts (a funded mainnet puller, a merchant wallet, and where to host it, following [guide/deploy.md](guide/deploy.md)); record the walkthrough with a real wallet extension (Phantom, Solflare or Backpack on devnet).
2. Ask someone new to follow the [quickstart](guide/quickstart.md) and time it.
3. Start M4: x402 and MPP middleware feeding the ledger, per-model token pricing.
4. Finish spike S3 (decode program events) when moving the reconciler from polling to events.

Done on 2026-11-17: S1 answered from the program source and its tests (D3 holds); monorepo scaffolded; M1 built; M2 built and its devnet scenarios passed; M3 built (plan changes with proration, scheduled downgrades, one-off and automatic top-ups, customer portal, merchant dashboard, CLI and SDK additions, Docker, mainnet settings, the guide) and its devnet scenarios passed (see the M3 results in [05-roadmap-and-grant.md](05-roadmap-and-grant.md#m3-results-2026-11-17)).

## Vocabulary

These terms are used the same way in every document.

| Term | Meaning |
| --- | --- |
| Merchant | The business that integrates `nummo` (for example an AI startup). |
| Customer | The merchant's end user or end organisation, the one who pays. |
| Feature | Something a customer can use. Either boolean (has SSO or not) or metered (messages, tokens). |
| Credit system | A shared balance that several metered features draw from at different rates. |
| Plan | A named bundle of a base price and plan items. A plan has versions; a price change creates a new version. |
| Plan item | One feature inside a plan: how much is included, when it resets, and what overage costs. |
| Grant | An amount of a feature given to a customer, with a source and an optional expiry. |
| Balance | What a customer has left of a feature: the sum of their unexpired grants minus usage. |
| Usage event | An immutable record that a customer used some amount of a feature. |
| Overage | Usage beyond the included amount, billed per unit. |
| Ceiling | The most that can be pulled from a customer's wallet in one billing period. Enforced on-chain. |
| Puller | The wallet allowed to sign pull transactions for a plan. |
| Settlement | Moving the money owed from the customer's wallet to the merchant's. |
| Base units | The smallest unit of a token. USDC has 6 decimals, so 1 USDC is 1,000,000 base units. |
