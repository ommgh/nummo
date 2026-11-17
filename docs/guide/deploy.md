# Self-hosting and mainnet

nummo is two processes and a Postgres database:

| Process | Command | Does |
| --- | --- | --- |
| API | `node apps/api/src/server.ts` | `/v1` API, hosted checkout, customer portal, merchant dashboard. Applies migrations on start. |
| Worker | `node apps/worker/src/main.ts` | Renewals, overage and top-up pulls, retries, reconciliation with the chain, webhook delivery. Safe to run two: each job takes a Postgres advisory lock. |

Node runs the TypeScript directly, so there is no build step.

## Docker

```bash
docker build -t nummo .
docker run --env-file .env -p 8787:8787 nummo                        # API
docker run --env-file .env nummo node apps/worker/src/main.ts         # worker
```

Or everything locally, with the puller keypair at `./keys/puller.json`:

```bash
docker compose --profile app up --build
```

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | local | Postgres connection string. |
| `PORT` | 8787 | API port. |
| `NUMMO_PUBLIC_URL` | `http://localhost:8787` | Public base URL: checkout, portal and plan metadata links. Use `https://` in production; the dashboard cookie is then marked Secure. |
| `NUMMO_TEST_PULLER_KEY`, `NUMMO_LIVE_PULLER_KEY` | — | Puller keypair (file path or JSON byte array) per environment. Without one, that environment's settlement is off. |
| `NUMMO_TEST_RPC_URL`, `NUMMO_LIVE_RPC_URL` | public cluster | RPC endpoint. Use a provider's on mainnet. |
| `NUMMO_TEST_MINT`, `NUMMO_LIVE_MINT` | USDC | Token mint. Mainnet refuses anything but USDC unless `NUMMO_LIVE_ALLOW_MINT` names it too. |
| `NUMMO_TEST_PRIORITY_FEE`, `NUMMO_LIVE_PRIORITY_FEE` | 0, 10000 | Micro-lamports per compute unit. |
| `NUMMO_SETTLEMENT_THRESHOLD` | 5 | USDC of overage accrued before it is pulled mid-period. |
| `NUMMO_RETRY_SCHEDULE` | `1h,6h,24h,72h` | Retries after a failed pull. Keep the last one shorter than your shortest billing period. |
| `NUMMO_SETTLE_EVERY`, `NUMMO_RECONCILE_EVERY` | 10s, 2m | Worker cadences. |
| `MIGRATE_ON_START` | 1 | Set to 0 on all but one process if you migrate separately. |

Test keys (`nummo_sk_test_…`) settle on devnet, live keys (`nummo_sk_live_…`) on mainnet, with separate data. `pnpm --filter @usenummo/api bootstrap --org <org id> --live` adds a live key to an org.

## Keys and custody

- The **merchant wallet** owns the on-chain plans and receives every payment. Its key never touches the server: plans are published from the dashboard with a browser wallet or from the CLI on your machine.
- The **puller** is a hot wallet on the server. It can only pull into the merchant's wallet (the plan's destination list) and only up to each customer's signed ceiling. Keep just enough SOL in it for fees and rent: about 0.0027 SOL per new subscriber, and a few thousand lamports per pull.

## Before real money: mainnet checklist

1. Create a live key and sign in to the dashboard with it; check the badge says **live · mainnet**.
2. Set `NUMMO_LIVE_PULLER_KEY` to a **new** keypair (`nummo wallet new`), funded with a little mainnet SOL. Never reuse the devnet puller.
3. Set `NUMMO_LIVE_RPC_URL` to a provider's endpoint, and `NUMMO_PUBLIC_URL` to your HTTPS address.
4. Push the config with the live key, and publish the paid plans from a merchant wallet you control (a hardware wallet is a good idea). The ceiling you publish is permanent for that version: check it.
5. Start with small amounts: a plan priced at 1 USDC with a short period, subscribed from your own second wallet. Watch one renewal and run `nummo verify`.
6. Register a webhook endpoint and confirm deliveries in the dashboard.
7. Back up Postgres. The chain holds the money and the subscriptions, but the ledger (credits, usage, invoices) lives in your database.

Stablecoin payments have tax and regulatory consequences that depend on where you and your customers are. nummo is non-custodial software and does not handle them; get professional advice before charging real customers.
