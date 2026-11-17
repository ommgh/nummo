# 02. Architecture

## Components

```
 Merchant backend                     Customer browser
       |                                     |
       | SDK: check / track / attach         | wallet signs
       v                                     v
 +-----------+                        +--------------+
 |    API    | <--------------------- |  Web app     |
 |  (Hono)   |                        |  checkout,   |
 +-----------+                        |  portal,     |
       |                              |  dashboard   |
       v                              +--------------+
 +-----------------------------------------------+
 |  Postgres: config, ledger, usage events,      |
 |  subscriptions, invoices, payments, outbox    |
 +-----------------------------------------------+
       ^                         ^
       |                         |
 +--------------+         +--------------+
 |  Settlement  |         |  Reconciler  |
 |  worker      |         |              |
 +--------------+         +--------------+
       |                         |
       v                         v
   Solana RPC: Subscriptions program, SPL Token
```

| Component | Job |
| --- | --- |
| API | Serves `check`, `track`, `attach`, reservations, customer reads, and config pushes. Stateless. |
| Core library | Pure functions for pricing, deduction order, proration and invoice building. No I/O, so it is easy to test. |
| Settlement worker | Finds amounts that are due and pulls them on-chain. Handles retries and the failed-payment state machine. |
| Reconciler | Reads on-chain accounts and events and corrects our records. This is what replaces Stripe webhooks. |
| Web app | Hosted checkout and customer portal (wallet connect), and the merchant dashboard. In M2 the checkout is one page served by the API; the rest arrives in M3. |
| SDK and CLI | TypeScript client for the API, and a CLI that applies the pricing config. |
| Webhook dispatcher | Delivers signed events to the merchant from an outbox table. |

## Stack

| Layer | Choice | Reason |
| --- | --- | --- |
| Language | TypeScript, Node 22 | The Solana SDKs we need are TypeScript first. |
| Monorepo | pnpm workspaces | The Solana docs and SDKs use pnpm. |
| API | Hono | Small, fast, runs on Node now and on edge runtimes later. |
| Database | Postgres with Drizzle ORM | One datastore for the first version. Transactions and row locks give us correct concurrent deductions. |
| Jobs | Loops guarded by Postgres advisory locks (M2); pg-boss when a real queue is needed | Inside Postgres, so no Redis yet. |
| Solana | `@solana/kit`, `@solana/subscriptions`, `@solana-program/token` | The packages the official guides use. |
| Local chain | Surfpool, then devnet | The Subscriptions docs describe local Surfpool workflows with the program at its real address. |
| Web | Next.js, Wallet Standard | Checkout, portal and dashboard in one app. |
| Tests | Vitest, fast-check | Property tests for the ledger rules. |

Redis and ClickHouse are deliberately left out. Autumn uses both at scale. We add Redis only when `check` latency needs it, and a columnar store only when usage analytics need it.

## Repository layout

```
apps/
  api/          HTTP API
  worker/       settlement worker, reconciler, webhook dispatcher
  web/          checkout, customer portal, merchant dashboard
  demo/         example AI chat app that uses the SDK
packages/
  core/         pricing, deduction, proration, invoice building (pure)
  db/           schema, migrations, queries
  solana/       chain adapter: build, send and confirm transactions; read accounts; FakeChain for tests
  settlement/   checkout, settlement worker, failed payments, reconciler, verify, webhook dispatcher
  sdk/          TypeScript client
  config/       feature() and plan() builders, config validation
  cli/          push config, publish plans, verify, inspect customers
e2e/            scripted devnet scenarios
docs/
```

## Data model

Every table carries `org_id` (the merchant) and `env` (`test` for devnet, `live` for mainnet). Money is stored as integers in token base units. Quantities of features and credits are `numeric`, because rates such as half a credit are allowed.

**Config**

| Table | Key columns |
| --- | --- |
| `features` | `id`, `type` (boolean, metered, credit_system), `consumable` |
| `credit_rates` | `credit_feature_id`, `metered_feature_id`, `credits_per_unit`, `billing_units` |
| `plans` | `id`, `name`, `is_addon` |
| `plan_versions` | `plan_id`, `version`, `base_amount`, `period_hours`, `ceiling_amount`, `mint`, `onchain_plan_pda`, `status` (draft, active, sunset) |
| `plan_items` | `plan_version_id`, `feature_id`, `included`, `reset` (period, never), `overage_price`, `overage_billing_units`, `overage_cap` |

**Customers and subscriptions**

| Table | Key columns |
| --- | --- |
| `customers` | `id` (the merchant's own user id), `name`, `email` |
| `customer_wallets` | `customer_id`, `address`, `verified_at` |
| `subscriptions` | `customer_id`, `plan_version_id`, `wallet`, `subscription_pda`, `status`, `period_anchor` (periods are anchor + k × period), `cancel_at`, `past_due_since`, `retry_count`, `next_retry_at`, `overage_blocked_until`, `ended_reason` |

**Ledger**

| Table | Key columns |
| --- | --- |
| `grants` | `customer_id`, `feature_id`, `source` (plan, topup, manual, reward), `amount`, `remaining`, `interval`, `expires_at` |
| `usage_events` | `id`, `customer_id`, `feature_id`, `value`, `properties`, `idempotency_key`, `occurred_at`. Append-only. |
| `ledger_entries` | `customer_id`, `feature_id`, `grant_id`, `delta`, `reason` (grant, usage, expiry, reset, adjustment, lock, release), `usage_event_id` |
| `locks` | `lock_id`, `customer_id`, `feature_id`, `held`, `expires_at`, `status` |
| `accruals` | `subscription_id`, `period_start`, `feature_id`, `billable_units`, `amount`. Overage that is owed but not yet collected. |

**Money**

| Table | Key columns |
| --- | --- |
| `invoices` | `customer_id`, `subscription_id`, `period_start`, `total`, `status` (open, paid, failed, void) |
| `invoice_lines` | `invoice_id`, `kind` (base, overage, topup, proration), `feature_id`, `quantity`, `amount` |
| `payments` | `invoice_id`, `signature`, `amount`, `status` (confirmed, finalized, reverted) |
| `settlement_attempts` | `invoice_id` or `checkout_session_id`, `attempt`, `signature`, `last_valid_block_height`, `status` (pending, confirmed, failed, expired), `error_kind`, `onchain_period_start` |
| `checkout_sessions` | `customer_id`, `plan_version_id`, `subscription_id`, `status` (open, submitted, completed, expired), `wallet`, `message`, `signature` |
| `webhook_endpoints` | `url`, `secret` |
| `outbox` | `event_type`, `payload`, `delivered_at`, `attempts`, `next_attempt_at`, `dead_at` |

## Ledger rules

These are the rules the core library implements. They follow Polar's principle that every number is derived from events ([Polar field guide](https://polar.sh/field-guide)) and Autumn's documented balance behaviour ([Autumn balances](https://docs.useautumn.com/documentation/concepts/balances)).

1. **Events are facts and are never edited.** A correction is a new entry with the opposite sign.
2. **A balance is the sum of unexpired grants' `remaining`.** `remaining` is a cached value. It must always equal the grant amount plus the sum of that grant's ledger entries, and a test checks this.
3. **Deduction order.** Grants that reset on a shorter interval are used first. Among equal intervals, the one expiring soonest is used first. Grants that never expire are used last. A direct feature balance is used before a credit system balance.
4. **Credit systems.** Usage of a feature is multiplied by its rate and deducted from the credit balance. Callers always name the underlying feature, never the credit system.
5. **No negative balance without overage.** If the plan item has no overage price, `check` refuses once the balance is zero. If it has one, usage continues, and the excess is added to `accruals`.
6. **Overage is bounded twice.** By the plan item's cap, and by whether the last settlement attempt succeeded. A customer with a failed payment cannot accrue more overage.
7. **Tracking is idempotent.** A second `track` with the same idempotency key returns the first result and changes nothing.
8. **Reservations.** A lock reduces the available balance at once. Confirming it deducts the real amount and returns the rest. An expired lock is released.
9. **Period resets.** At the start of each period, grants that reset are replaced with fresh ones. The period comes from the on-chain subscription for paid plans, and from the customer's creation time for free plans.

## The hot path: `check` and `track`

Both run inside one Postgres transaction.

1. Look up the customer's active grants for the feature (or its credit system) and lock those rows with `SELECT ... FOR UPDATE`.
2. Compute what is available after open locks.
3. For `check` without a lock: return `allowed` and the balance.
4. For `track`, or `check` with a lock: walk the grants in deduction order, reduce `remaining`, write ledger entries, and write the usage event.
5. If the balance crossed a threshold, write an outbox event (`balance.low`, `balance.depleted`).

Row locks on a single customer's grants make concurrent requests for that customer queue behind each other, which is what prevents overselling. Different customers do not block each other.

Target for the first version: under 50 ms at the median for one region. If a merchant needs less, the next step is the pattern Autumn and Polar both use: answer checks from a cache next to the merchant's code and sync in the background.

**Failure mode.** The SDK fails open by default, as Autumn's does: if the API cannot be reached, `check` returns allowed and the SDK queues usage to resend. The merchant can switch a feature to fail closed.

## Subscription states

```
            activate                 pull fails
 (none) ---------------> active ----------------> past_due
                          |  ^                       |
          cancel signed   |  | pull succeeds         | grace period ends
                          v  |                       v
                     canceling --- period ends ---> ended
```

| State | Entitlements | Overage |
| --- | --- | --- |
| `active` | Full | Allowed up to the cap |
| `past_due` | Full during the grace period | Blocked |
| `canceling` | Full until the period ends | Allowed up to the cap, collected before the period ends |
| `ended` | Fall back to the free plan, if one exists | Blocked |

## Webhooks to the merchant

Events are written to the outbox in the same transaction as the change they describe, then delivered with an HMAC signature and retried with backoff.

`subscription.activated`, `subscription.renewed`, `subscription.past_due`, `subscription.canceled`, `subscription.ended`, `payment.succeeded`, `payment.failed`, `balance.low`, `balance.depleted`, `invoice.finalized`.

## Security basics

- API keys are stored hashed. Test and live keys are separate.
- The puller key lives in the worker's environment or a key management service, never in the database.
- All amounts are validated as integers in base units at the API boundary. No floating point anywhere near money.
- The checkout builds the transaction on the server and the wallet signs it. Before co-signing, the server checks that the signed transaction contains only the instructions it built.
- Rate limits per API key and per customer.
