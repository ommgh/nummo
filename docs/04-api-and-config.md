# 04. API, SDK and pricing config

Everything in this document is a proposal for our own interface. Names can change during the build. The shape follows Autumn's three calls (`attach`, `check`, `track`) because that interface is what developers praised, and Polar's billing-as-code idea.

## Pricing config

Pricing lives in one file in the merchant's repository and is applied with the CLI.

```ts
// nummo.config.ts
import { defineConfig, feature, plan, usdc } from "@usenummo/config";

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

Since M3 the config can also carry one-off top-up prices (`topUps`), the wallet that receives them (`payTo`), and an automatic top-up per plan item (`autoTopUp`), whose most per period is added to the ceiling. Every option is in the [pricing config guide](guide/pricing-config.md).

Rules:

- `period` is a number of days or hours. There are no calendar months on-chain.
- Changing `price`, `period`, an overage cap or an automatic top-up requires a new `version`, because the on-chain plan cannot change. Changing included amounts or feature lists within the same ceiling does not.
- A plan with no `price` and no overage needs nothing on-chain.

## CLI

| Command | What it does |
| --- | --- |
| `nummo login --key <key> [--api <url>]` | Stores a secret key (mode 0600, in the user's config directory). `NUMMO_SECRET_KEY` and `NUMMO_API_URL` still win. `nummo logout`, `nummo whoami`. |
| `nummo init` | Writes a starter `nummo.config.ts`. |
| `nummo wallet new <file>` / `wallet balance <file or address>` | Creates a keypair file in the Solana CLI format; shows SOL and USDC on devnet or mainnet. |
| `nummo push` | Shows a diff between the file and what is deployed, then applies it on confirmation. |
| `nummo push --yes` | Applies without asking. For CI. |
| `nummo plans` | Lists plan versions with their on-chain ceiling and whether they are published. |
| `nummo plans publish --keypair <file>` | Creates the on-chain plan for any new paid plan version, signed by the merchant wallet, and registers it. The server checks the plan on-chain (ceiling, period, mint, puller, destination) before accepting it. |
| `nummo customers list [--search]`, `customers get <id>` | Lists customers with their plans; prints one customer's plans, balances and invoices. |
| `nummo preview <customer> <plan>`, `attach <customer> <plan>` | What a plan change costs now; attach it (printing the checkout link for a paid plan). |
| `nummo portal <customer>` | A customer portal link. |
| `nummo dashboard` | The dashboard's address. |
| `nummo verify` | Compares our records with the chain and lists differences. Exits 1 on drift. |

In the repository the CLI is `pnpm nummo <command>` (package `packages/cli`); it will be published as the unscoped `nummo` package.

Publishing a plan on-chain needs the merchant's wallet, so it is a separate step from `push`. The dashboard offers the same step with a browser wallet ("Publish with wallet" on the Plans page): the server builds the transaction with the merchant as fee payer, the wallet signs, and the server sends it and checks the plan on-chain before registering it.

## SDK

```ts
import { Nummo } from "@usenummo/sdk";

const nummo = new Nummo({ secretKey: process.env.NUMMO_SECRET_KEY });
```

### attach: put a customer on a plan

```ts
const result = await nummo.attach({
  customerId: "user_123",
  planId: "pro",
  successUrl: "https://app.example.com/billing?ok=1",
});

if (result.checkoutUrl) redirect(result.checkoutUrl);
```

- Free plan: attached at once, no URL returned.
- Paid plan: returns `status: "pending"` and a checkout URL where the customer connects a wallet and signs once. The plan version must be published on-chain first (`plan_not_published` otherwise). Calling `attach` again while the checkout is open returns the same URL.
- Customer already on a paid plan (M3):
  - **Upgrade** (the new plan costs at least as much per hour, and the credit fits in its base fee): `status: "pending"` with a checkout URL and `proration: { credit, dueNow }`. The wallet paying for the current plan signs once: subscribe to the new plan, pull `dueNow` (the new base fee less the unused part of the current period's), and cancel the old subscription. The old one stops granting at once, collects overage already used, and ends with its on-chain period.
  - **Downgrade** (cheaper, or a free plan): `status: "scheduled"` with `effectiveAt`, the end of the current period. A free plan starts then; a paid one becomes a checkout for the customer to sign, listed in `pendingCheckouts` and the portal.
  - Attaching the current plan again cancels a scheduled downgrade.
  - `plan_change_blocked` while a payment on the current plan is failing or in flight.
- Test environment only: `skipPayment: true` activates a paid plan without a wallet, for tests and demos.

`nummo.preview({ customerId, planId })` returns what would happen and be charged today, without changing anything: `change` (`new`, `upgrade`, `downgrade`, `none`, `blocked`), `dueNow`, `credit`, `effectiveAt`, the target plan with its ceiling, and whether the customer must sign.

### check: may this customer do this

```ts
const { allowed, balance } = await nummo.check({
  customerId: "user_123",
  featureId: "premium_message",
  requiredBalance: 1,
});

if (!allowed) return showUpgradePrompt();
```

For a boolean feature, omit `requiredBalance`. The response includes the remaining balance, whether overage is allowed, and the next reset time.

### track: record usage

```ts
await nummo.track({
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

const { allowed } = await nummo.check({
  customerId: "user_123",
  featureId: "tokens",
  requiredBalance: 4000,
  lock: { lockId, expiresAt: Date.now() + 60_000 },
});
if (!allowed) return showUpgradePrompt();

const completion = await runModel();

await nummo.balances.finalize({
  lockId,
  action: "confirm",
  overrideValue: completion.usage.totalTokens,
});
```

`action: "release"` returns the whole hold. A lock that passes `expiresAt` without being finalised is released.

### Per-model token pricing (M4)

```ts
await nummo.trackTokens({ customerId: "user_123", model: "claude-sonnet-5-5", usage: { input: 1200, output: 340 }, idempotencyKey: requestId });
const { allowed } = await nummo.checkTokens({ customerId: "user_123", model: "claude-sonnet-5-5", usage: { input: 1200, output: 4000 } });
```

Models and their provider prices are in the config's `models` section; each kind of token is a metered feature drawing from a credit system at a rate derived from the price, a markup and what a credit is worth. See the [pricing config guide](guide/pricing-config.md#per-model-token-pricing).

### paywall: agents pay per request (M4)

```ts
const gate = nummo.paywall({ featureId: "premium_message", identify: (req) => userIdFrom(req) });
app.post("/agent/chat", gate.hono(), handler);
```

A signed-in customer with the balance is served from it. Anyone else gets a 402 offering x402 and MPP at the `payPerUse` price, and is served once they pay; the payment is recorded against them or against the paying wallet (`wallet:<address>`). See [billing flows](guide/billing-flows.md#agents-paying-per-request).

### Reading a customer

```ts
const customer = await nummo.customers.get("user_123");
// customer.subscriptions, customer.balances, customer.invoices, customer.pendingCheckouts
```

This is what a merchant uses to render their own billing page. Each balance includes a `breakdown` array with one entry per grant, so the page can show plan credits and top-up credits separately. Each subscription carries `replacedBy` (set after an upgrade replaced it) and `scheduledChange`. `nummo.customers.list({ search })` pages through customers.

### Top-ups

```ts
const { checkoutUrl } = await nummo.topUp({
  customerId: "user_123",
  featureId: "credits",
  amount: usdc("10"),
});
```

`amount` is in base units and must sit between the top-up's `min` and `max`; the response says how many units it buys. The checkout asks the customer's wallet to sign a plain USDC transfer to the merchant (fee paid by the puller), carrying a random reference key as the Solana Pay convention does. The balance is granted when the transfer confirms and never expires.

Automatic top-up is part of a plan's config (threshold, refill amount, and a per-period maximum that becomes part of the ceiling), so it needs no extra signature after activation. When usage takes the balance below the threshold, a `topup` invoice is written on the subscription; the worker pulls it like any other, and the credits are granted once the pull confirms. A refill is never cut by the ceiling: it is dropped instead.

### Customer portal

```ts
const { url } = await nummo.portal({ customerId: "user_123" });
```

The portal shows the plan, the on-chain ceiling, usage this period, receipts with links to each transaction, plan changes (with a preview of what each costs), top-ups, and cancel and resume buttons that ask the wallet to sign `cancelSubscription` or `resumeSubscription`. The link lasts an hour; create one each time a signed-in customer opens billing.

## REST endpoints

All endpoints take a bearer API key. Bodies are JSON. Amounts are strings of base units.

| Method and path | Purpose |
| --- | --- |
| `POST /v1/attach` | Attach a plan, or get a checkout URL |
| `POST /v1/preview` | Preview a plan change `{ customerId, planId, version? }` |
| `POST /v1/check` | Check access, optionally lock or deduct |
| `POST /v1/track` | Record usage |
| `POST /v1/track/batch` | Record up to 1,000 usage events |
| `POST /v1/track/tokens` | Record a model call's tokens `{ customerId, model, usage: { input, output, cachedInput }, idempotencyKey? }` (M4) |
| `POST /v1/check/tokens` | May this customer make this model call `{ customerId, model, usage }` (M4) |
| `POST /v1/pay` | Behind `paywall`: `{ request: { method, url, headers }, featureId, value?, customerId? }`. Answers `allowed` (served from a balance), `payment_required` (the 402 to send as it is), or `paid` (settled and recorded, with receipt headers) (M4) |
| `POST /v1/balances/finalize` | Confirm or release a lock |
| `POST /v1/balances` | Grant a balance by hand |
| `POST /v1/topups` | Start a one-off purchase `{ customerId, featureId, amount, successUrl? }`; returns a checkout URL |
| `POST /v1/portal` | Create a portal session `{ customerId, returnUrl? }`; returns `{ url, expiresAt }` |
| `GET /v1/customers` | Customers with their live plans; `search`, `limit`, `offset` |
| `GET /v1/customers/:id` | Customer with subscriptions, balances and recent invoices |
| `PUT /v1/customers/:id` | Create or update a customer |
| `GET /v1/customers/:id/invoices` | Invoices with their lines and payments (transaction signatures) |
| `GET /v1/events` | Usage events, filtered by customer, feature and time |
| `PUT /v1/config` | Apply a pricing config (used by the CLI) |
| `GET /v1/plans` | Plan versions, their on-chain terms, and the deployment's network, mint and puller |
| `POST /v1/plans/:planId/versions/:version/publish` | Register the on-chain plan created for a version, `{ "address" }`. Checked on-chain first. |
| `GET /v1/verify` | Differences between our records and the chain |
| `GET`, `PUT`, `DELETE /v1/webhook` | The webhook endpoint, `{ "url" }`. `PUT` returns the signing secret. |

The hosted checkout is public and keyed only by its long random session id, like a payment link: `GET /checkout/:id` (the page), `GET /checkout/:id/session`, `POST /checkout/:id/transaction { wallet }` (returns the unsigned transaction), and `POST /checkout/:id/submit { signedTransaction }`. `GET /p/:id` serves the on-chain plan's metadata. The same routes serve plan changes and top-ups; the session's `kind` (`subscribe`, `change`, `topup`) says which.

The customer portal is public in the same way: `GET /portal/:id` (the page), `GET /portal/:id/data`, `POST /portal/:id/transaction { action: "cancel" | "resume", subscriptionId, wallet }`, `POST /portal/:id/submit { signedTransaction }`, `POST /portal/:id/change { planId, confirm }` and `POST /portal/:id/topup { featureId, amount }`.

The merchant dashboard is at `/dashboard`. Sign-in takes a secret key and sets an HttpOnly, SameSite=Strict cookie holding a random session token, never the key.

Settlement endpoints answer `503 settlement_unavailable` when the server has no puller key for the environment (`NUMMO_TEST_PULLER_KEY`, `NUMMO_LIVE_PULLER_KEY`).

Errors use a consistent body: `{ "error": { "code": "insufficient_balance", "message": "..." } }`. A `check` that is refused is a 200 with `allowed: false`, not an error.

## Webhook events

Delivered as `POST` with a JSON body `{ id, type, env, createdAt, data }` and an `X-Nummo-Signature: t=<unix seconds>,v1=<hex>` header, where `v1` is the HMAC-SHA256 of `"<t>.<raw body>"` with the endpoint's secret. Signing the timestamp lets receivers reject replays; `verifyWebhook(rawBody, header, secret)` in the SDK does the check. Failed deliveries retry with backoff from 10 seconds up to 6 hours, 12 attempts in all. Only events created after the endpoint was registered are sent.

| Event | When |
| --- | --- |
| `subscription.activated` | First charge confirmed |
| `subscription.renewed` | A period's base fee was collected |
| `subscription.past_due` | A pull failed and retries have started |
| `subscription.canceled` | The customer signed a cancellation; includes the end time. `reason: "replaced"` when an upgrade replaced it |
| `subscription.resumed` | The customer resumed a cancelled subscription before it ended |
| `subscription.change_scheduled` | A downgrade was scheduled for the period end (`planId`, `effectiveAt`), or cancelled (`canceled: true`) |
| `subscription.ended` | Entitlements removed. `next` describes a scheduled plan that took over (a pending checkout if it is paid) |
| `payment.succeeded` | Any pull or purchase confirmed; includes the transaction signature; `kind: "topup"` for a one-off purchase, `kind: "pay_per_use"` with `protocol` and `wallet` for a request an agent paid for |
| `payment.failed` | A pull failed; includes the reason |
| `balance.low` | A balance crossed the configured warning threshold |
| `balance.depleted` | A balance reached zero |
| `invoice.finalized` | An invoice was written: `kind` is `activation`, `renewal`, `overage`, `topup` (`automatic: true` for a refill) or `pay_per_use` |

A merchant who uses `check` on every request does not need webhooks to gate access. They are for notifications and for copying state into the merchant's own database.

## What the demo app shows

The example in `apps/demo` is an AI chat app with the config above:

1. A new user chats on the free plan until 100 credits run out.
2. They upgrade to Pro: connect a wallet, sign once, and the first 20 USDC moves.
3. Premium messages draw 10 credits each. Past 1,000 credits, overage accrues and is collected every 5 USDC.
4. "Billing" opens the portal: the 70 USDC ceiling, usage, receipts, a prorated upgrade to Team, and cancel with the wallet.
5. "Buy 500 credits" is a one-off top-up of 5 USDC, signed once.
6. They empty the wallet. The next pull fails, the account goes past due, and after the grace period it falls back to free.
7. Milestone M4: a script acting as an agent (`src/agent.ts`) pays the same API per request over x402 and MPP (`POST /agent/chat`, 0.01 USDC a premium message) and appears in the same dashboard as customer `wallet:<address>`. `POST /api/complete` charges a model call per token at the model's price.
