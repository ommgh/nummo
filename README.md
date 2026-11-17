# nummo

Open-source usage billing and entitlements, settled in stablecoins on Solana. Plans, credit balances and a usage ledger with `check` and `track`, collecting USDC through Solana's native Subscriptions program. The plan is in [docs/](docs/README.md).

**Status:** milestones M1 (ledger core) and M2 (settlement on devnet) are built. A customer wallet subscribes with one signature and no SOL; renewals, overage, failed payments and cancellations are settled and reconciled on devnet. Results are in [docs/05-roadmap-and-grant.md](docs/05-roadmap-and-grant.md#m2-results-2026-11-17); spike results in [spikes/README.md](spikes/README.md).

## Quickstart

Needs Node 22.18+ (TypeScript runs natively, no build step), pnpm and Docker.

```bash
pnpm install
pnpm db:up                                   # Postgres 18 on localhost:5434
pnpm --filter @usenummo/api bootstrap "Acme AI"  # creates an org, prints a test API key
export NUMMO_SECRET_KEY=nummo_sk_test_...      # the key it printed
pnpm dev:api                                 # API on http://localhost:8787

# in another shell, with NUMMO_SECRET_KEY set
pnpm --filter @usenummo/demo push                # apply apps/demo/nummo.config.ts
pnpm --filter @usenummo/demo dev                 # demo chat on http://localhost:3000
```

```ts
import { Nummo } from "@usenummo/sdk";
const nummo = new Nummo(); // reads NUMMO_SECRET_KEY and NUMMO_API_URL

const { allowed } = await nummo.check({ customerId: "user_123", featureId: "premium_message", sendEvent: true });
const { checkoutUrl } = await nummo.attach({ customerId: "user_123", planId: "pro" }); // paid plan: wallet checkout
```

### Settling on devnet

Paid plans need two wallets: the **merchant** wallet, which owns the on-chain plan and receives funds (its key stays on your machine), and a **puller** hot wallet, which signs pulls and pays fees and rent (its key is in the API's and worker's environment). Fund both with a little devnet SOL at https://faucet.solana.com.

```bash
export NUMMO_TEST_PULLER_KEY=./keys/puller.json   # see .env.example for every setting
pnpm dev:api                                      # now serves checkout at /checkout/:id
pnpm dev:worker                                   # renewals, overage, retries, reconciler, webhooks

pnpm nummo push --config apps/demo/nummo.config.ts
pnpm nummo plans publish --keypair ./keys/merchant.json   # creates the on-chain plan per paid version
pnpm nummo verify                                         # our records against the chain
```

`attach` on a paid plan returns a checkout URL. The page reads the price, period and ceiling from the chain, the customer's wallet signs one transaction (create authority, subscribe, first pull), and the puller co-signs and pays. Customers need devnet USDC from https://faucet.circle.com, and no SOL.

## Layout

| Path | What |
| --- | --- |
| `packages/core` | Pure rules: exact quantities (bigint, 10^-9), money in base units, periods, deduction order, credit systems, overage and caps. No I/O. |
| `packages/config` | `feature()`, `plan()`, `defineConfig()`, validation, and the on-chain terms each paid plan version needs. |
| `packages/db` | Drizzle schema and migrations, the hot path (every operation runs in one transaction holding the customer's row lock), and subscription state transitions. |
| `packages/solana` | The `Chain` interface: read plans, records and authorities; build the one-signature activation; prepare, send and confirm pulls. `SolanaChain` over `@solana/kit`, and `FakeChain`, an in-memory stand-in that follows the program's rules, for tests. |
| `packages/settlement` | Checkout, the settlement worker (renewals, overage, safe resend), the failed-payment state machine, the reconciler, `verify`, and the webhook dispatcher. |
| `packages/sdk` | TypeScript client. Fails open; queued `track` calls carry idempotency keys so a resend never double counts. `verifyWebhook` for receivers. |
| `packages/cli` | `nummo push`, `plans`, `plans publish`, `verify`, `customers get`. Run with `pnpm nummo`. |
| `apps/api` | Hono HTTP API (`/v1/...`) and the hosted checkout (`/checkout/:id`). |
| `apps/worker` | Runs settlement, reconciliation and webhook delivery on their own cadences. |
| `apps/demo` | AI chat demo that gates messages on credits and upgrades through checkout. |
| `e2e` | Scripted devnet scenarios: activation, overage, failed payment, cancellation, webhooks, renewal. |
| `spikes` | Throwaway devnet experiments (S1 to S3). |

## Tests

```bash
pnpm test:unit                 # core, config, FakeChain, settings; fast-check property tests
FC_NUM_RUNS=5000 pnpm test:unit
pnpm test:db                   # against Postgres (database nummo_test): hot path, concurrency, settlement, API
pnpm typecheck

node e2e/devnet.ts run         # devnet, about 2 minutes; needs the funded wallets in spikes/.keys
node e2e/devnet.ts renewal     # after the scenario's 1-hour period ends
node e2e/checkout-page.ts      # serves a live devnet checkout on :8790 for a browser test
```

The db suite and the devnet script use their own databases (`nummo_test`, `nummo_e2e`), created on first run, because a worker settles every org in an environment.

## Licence

[Apache-2.0](LICENSE).
