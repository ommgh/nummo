# nummo

Open-source usage billing and entitlements, settled in stablecoins on Solana. Plans, credit balances and a usage ledger with `check` and `track`, collecting USDC through Solana's native Subscriptions program. The plan is in [docs/](docs/README.md).

**Status:** milestone M1 (ledger core, no chain) is built, and spikes S1 and S2 passed on devnet. Settlement on devnet (M2) is next. Spike results are in [spikes/README.md](spikes/README.md).

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
```

## Layout

| Path | What |
| --- | --- |
| `packages/core` | Pure rules: exact quantities (bigint, 10^-9), money in base units, periods, deduction order, credit systems, overage and caps. No I/O. |
| `packages/config` | `feature()`, `plan()`, `defineConfig()`, validation, and the on-chain terms each paid plan version needs. |
| `packages/db` | Drizzle schema and migrations, and the hot path: every operation runs in one transaction holding the customer's row lock. |
| `packages/sdk` | TypeScript client. Fails open; queued `track` calls carry idempotency keys so a resend never double counts. |
| `apps/api` | Hono HTTP API (`/v1/check`, `/v1/track`, `/v1/track/batch`, `/v1/balances/finalize`, `/v1/balances`, `/v1/attach`, `/v1/customers/:id`, `/v1/events`, `/v1/config`). |
| `apps/demo` | AI chat demo that gates messages on credits. |
| `spikes` | Throwaway devnet experiments (S1 to S3). |

## Tests

```bash
pnpm test:unit                 # core and config, including fast-check property tests
FC_NUM_RUNS=5000 pnpm test:unit
pnpm test:db                   # against Postgres: hot path, concurrency, API through the SDK
pnpm typecheck
```

## Licence

[Apache-2.0](LICENSE).
