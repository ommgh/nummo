# Pricing config

Pricing lives in one TypeScript file in your repository, usually `nummo.config.ts`, and is applied with `nummo push`. Each environment (test key, live key) has its own copy on the server.

```ts
import { defineConfig, feature, plan, usdc } from "@usenummo/config";
```

Amounts of money are always `usdc("20")`: integer base units (USDC has 6 decimals). Quantities of features may be decimals up to 9 places.

## Features

| Type | Example | Use |
| --- | --- | --- |
| `boolean` | `feature({ id: "sso", type: "boolean" })` | On or off per plan. `check` answers allowed or not. |
| `metered` | `feature({ id: "api_call", type: "metered" })` | Counted. `track` deducts from a balance. |
| `credit_system` | see below | One balance that several metered features draw from at different rates. |

```ts
const credits = feature({
  id: "credits",
  type: "credit_system",
  rates: [
    { feature: "basic_message", credits: 1 },
    { feature: "premium_message", credits: 10 },
  ],
});
```

Your code always names the underlying feature (`premium_message`); nummo converts it to credits.

Ids are lowercase letters, digits and underscores. A feature cannot change type; use a new id.

## Plans

```ts
plan({
  id: "pro",
  version: 1,
  name: "Pro",
  price: { amount: usdc("20"), period: "30d" },
  items: [
    { feature: "sso" },
    {
      feature: "credits",
      included: 1000,
      reset: "period",
      overage: { price: usdc("0.01"), per: 1, cap: usdc("50") },
      autoTopUp: { below: 100, quantity: 1000, price: usdc("10"), maxPerPeriod: 3 },
    },
  ],
});
```

| Field | Meaning |
| --- | --- |
| `price` | Base price and period. Periods are hours or days (`"12h"`, `"30d"`); there are no calendar months on-chain. Omit for a free plan. |
| `default: true` | Every new customer starts here, and anyone whose paid plan ends falls back to it. Must be free. One per config. |
| `isAddon: true` | Stacks on top of the main plan instead of replacing it. |
| `included` | Amount granted per reset. `0` for pure pay as you go. |
| `reset` | `"period"` (each billing period of a paid plan), a duration, or `"never"`. |
| `overage` | Usage past `included` is allowed and billed at `price` per `per` units, up to `cap` per period. Without it, `check` refuses at zero. |
| `autoTopUp` | When the balance drops below `below`, pull `price` from the subscription and grant `quantity`, at most `maxPerPeriod` times a period. Needs a paid plan (the price may be 0). |

### The on-chain ceiling

Every paid plan version becomes one Solana Subscriptions plan whose amount is the most it can ever charge per period:

```
ceiling = base price + every overage cap + every autoTopUp price × maxPerPeriod
```

The customer signs that ceiling once at checkout, and the program enforces it. nummo collects up to it with partial pulls: the base fee at each period start, overage as it accrues, refills when they trigger.

### Versions

The price, period, overage terms and automatic top-ups are frozen once a version exists, because customers signed them. Change any of them by adding a new `version`; existing subscribers stay on the old one. Names and included amounts can change in place.

## One-off top-ups

```ts
defineConfig({
  features: [...],
  plans: [...],
  topUps: [{ feature: "credits", price: usdc("1"), per: 100, min: usdc("1"), max: usdc("1000") }],
  payTo: "YourMerchantWa11et...",   // optional
});
```

`price` buys `per` units; `min` and `max` bound one purchase (defaults 1 and 1,000 USDC). A purchase is a plain USDC transfer the customer signs, to `payTo`, or by default to the wallet that owns your most recently published plan. Purchased balance never expires and is used after plan credits.

## Applying it

```bash
nummo push                 # shows the diff, asks, applies
nummo push --yes           # for CI
nummo plans                # each version, its ceiling, and whether it is on-chain
nummo plans publish --keypair merchant.json   # or the dashboard's "Publish with wallet"
```
