# 04. API, SDK and pricing config

Everything in this document is a proposal for our own interface. Names can change during the build. The shape follows Autumn's three calls (`attach`, `check`, `track`) because that interface is what developers praised, and Polar's billing-as-code idea.

## Pricing config

Pricing lives in one file in the merchant's repository and is applied with the CLI.

```ts
// bill.config.ts
import { defineConfig, feature, plan, usdc } from "@bill/config";

export const sso = feature({ id: "sso", type: "boolean" });

export const basicMessage = feature({ id: "basic_message", type: "metered", consumable: true });
export const premiumMessage = feature({ id: "premium_message", type: "metered", consumable: true });

export const credits = feature({
  id: "credits",
  type: "credit_system",
  rates: [
    { feature: basicMessage.id, credits: 1 },
    { feature: premiumMessage.id, credits: 10 },
  ],
});

export const free = plan({
  id: "free",
  version: 1,
  name: "Free",
  default: true,
  items: [{ feature: credits.id, included: 100, reset: "30d" }],
});

export const pro = plan({
  id: "pro",
  version: 1,
  name: "Pro",
  price: { amount: usdc("20"), period: "30d" },
  items: [
    { feature: sso.id },
    {
      feature: credits.id,
      included: 1000,
      reset: "period",
      overage: { price: usdc("0.01"), per: 1, cap: usdc("50") },
    },
  ],
});

export default defineConfig({
  mint: "USDC",
  features: [sso, basicMessage, premiumMessage, credits],
  plans: [free, pro],
});
```

From this config we derive the on-chain plan for `pro` version 1: amount 70 USDC (20 base plus 50 cap), period 720 hours.

Rules:

- `period` is a number of days or hours. There are no calendar months on-chain.
- Changing `price`, `period`, or an overage cap requires a new `version`, because the on-chain plan cannot change. Changing included amounts or feature lists within the same ceiling does not.
- A plan with no `price` and no overage needs nothing on-chain.

## CLI

| Command | What it does |
| --- | --- |
| `bill login` | Stores an API key for the test or live environment. |
| `bill push` | Shows a diff between the file and what is deployed, then applies it on confirmation. |
| `bill push --yes` | Applies without asking. For CI. |
| `bill plans publish` | Creates the on-chain plan for any new paid plan version. Needs the merchant wallet's signature. |
| `bill customers get <id>` | Prints a customer's plan, balances and recent usage. |
| `bill verify` | Compares our records with the chain and lists differences. |

Publishing a plan on-chain needs the merchant's wallet, so it is a separate step from `push`. The dashboard offers the same step with a browser wallet.

## SDK

```ts
import { Bill } from "@bill/sdk";

const bill = new Bill({ secretKey: process.env.BILL_SECRET_KEY });
```

### attach: put a customer on a plan

```ts
const result = await bill.attach({
  customerId: "user_123",
  planId: "pro",
  successUrl: "https://app.example.com/billing?ok=1",
});

if (result.checkoutUrl) redirect(result.checkoutUrl);
```

- Free plan: attached at once, no URL returned.
- Paid plan: returns a checkout URL where the customer connects a wallet and signs once.
- Customer already on a paid plan: returns a checkout URL for the upgrade or downgrade.

`bill.preview({ customerId, planId })` returns what would be charged today and the new ceiling, without changing anything.

### check: may this customer do this

```ts
const { allowed, balance } = await bill.check({
  customerId: "user_123",
  featureId: "premium_message",
  requiredBalance: 1,
});

if (!allowed) return showUpgradePrompt();
```

For a boolean feature, omit `requiredBalance`. The response includes the remaining balance, whether overage is allowed, and the next reset time.

### track: record usage

```ts
await bill.track({
  customerId: "user_123",
  featureId: "premium_message",
  value: 1,
  idempotencyKey: requestId,
  properties: { model: "claude-fable-5-2" },
});
```

`check` with `sendEvent: true` does both in one call for cheap, fast operations.

### Reservations: when the cost is unknown upfront

```ts
const lockId = `completion_${requestId}`;

const { allowed } = await bill.check({
  customerId: "user_123",
  featureId: "tokens",
  requiredBalance: 4000,
  lock: { lockId, expiresAt: Date.now() + 60_000 },
});
if (!allowed) return showUpgradePrompt();

const completion = await runModel();

await bill.balances.finalize({
  lockId,
  action: "confirm",
  overrideValue: completion.usage.totalTokens,
});
```

`action: "release"` returns the whole hold. A lock that passes `expiresAt` without being finalised is released.

### Reading a customer

```ts
const customer = await bill.customers.get("user_123");
// customer.subscriptions, customer.balances, customer.invoices
```

This is what a merchant uses to render their own billing page. Each balance includes a `breakdown` array with one entry per grant, so the page can show plan credits and top-up credits separately.

### Top-ups

```ts
const { checkoutUrl } = await bill.topUp({
  customerId: "user_123",
  featureId: "credits",
  amount: usdc("10"),
});
```

Automatic top-up is part of a plan's config (threshold, refill amount, and a per-period maximum that becomes part of the ceiling), so it needs no extra signature after activation.

### Customer portal

```ts
const { url } = await bill.portal({ customerId: "user_123" });
```

The portal shows the plan, the on-chain ceiling, usage this period, receipts with links to each transaction, and a cancel button that asks the wallet to sign `cancelSubscription`.

## REST endpoints

All endpoints take a bearer API key. Bodies are JSON. Amounts are strings of base units.

| Method and path | Purpose |
| --- | --- |
| `POST /v1/attach` | Attach a plan, or get a checkout URL |
| `POST /v1/preview` | Preview a plan change |
| `POST /v1/check` | Check access, optionally lock or deduct |
| `POST /v1/track` | Record usage |
| `POST /v1/track/batch` | Record up to 1,000 usage events |
| `POST /v1/balances/finalize` | Confirm or release a lock |
| `POST /v1/balances` | Grant a balance by hand |
| `POST /v1/topups` | Start a one-off purchase |
| `POST /v1/portal` | Create a portal session |
| `GET /v1/customers/:id` | Customer with subscriptions and balances |
| `PUT /v1/customers/:id` | Create or update a customer |
| `GET /v1/customers/:id/invoices` | Invoices and payments |
| `GET /v1/events` | Usage events, filtered by customer, feature and time |
| `PUT /v1/config` | Apply a pricing config (used by the CLI) |
| `GET /v1/verify` | Differences between our records and the chain |

Errors use a consistent body: `{ "error": { "code": "insufficient_balance", "message": "..." } }`. A `check` that is refused is a 200 with `allowed: false`, not an error.

## Webhook events

Delivered as `POST` with a JSON body and an `X-Bill-Signature` header (HMAC-SHA256 of the body with the endpoint's secret).

| Event | When |
| --- | --- |
| `subscription.activated` | First charge confirmed |
| `subscription.renewed` | A period's base fee was collected |
| `subscription.past_due` | A pull failed and retries have started |
| `subscription.canceled` | The customer signed a cancellation; includes the end time |
| `subscription.ended` | Entitlements removed |
| `payment.succeeded` | Any pull or purchase confirmed; includes the transaction signature |
| `payment.failed` | A pull failed; includes the reason |
| `balance.low` | A balance crossed the configured warning threshold |
| `balance.depleted` | A balance reached zero |
| `invoice.finalized` | A period's invoice is complete |

A merchant who uses `check` on every request does not need webhooks to gate access. They are for notifications and for copying state into the merchant's own database.

## What the demo app shows

The example in `apps/demo` is an AI chat app with the config above:

1. A new user chats on the free plan until 100 credits run out.
2. They upgrade to Pro: connect a wallet, sign once, and the first 20 USDC moves.
3. Premium messages draw 10 credits each. Past 1,000 credits, overage accrues and is collected every 5 USDC.
4. The portal shows the 70 USDC ceiling, usage, and receipts.
5. They empty the wallet. The next pull fails, the account goes past due, and after the grace period it falls back to free.
6. Later milestone: a script acting as an agent pays the same API per request over x402 and appears in the same dashboard.
