# nummo

Open-source usage billing and entitlements, settled in stablecoins on Solana. Plans, credit balances and a usage ledger with `check` and `track`, collecting USDC through Solana's native Subscriptions program. Customers sign once at checkout and need no SOL; the program enforces the most they can ever be charged per period.

**Status:** milestones M1 (ledger core), M2 (settlement on devnet), M3 (product surface) and M4 (agent payments and per-model token pricing) are built and pass their devnet scenarios: subscriptions, renewals, overage, failed payments, upgrades with proration, scheduled downgrades, one-off and automatic top-ups, a customer portal, a merchant dashboard, agents paying per request over x402 and MPP, and AI model calls charged per token. Not yet run on mainnet. Results are in [docs/05-roadmap-and-grant.md](docs/05-roadmap-and-grant.md#m4-results-2026-11-18).

**Start here:** the [quickstart](docs/guide/quickstart.md) charges a devnet wallet in under 30 minutes. The rest of the [guide](docs/guide/README.md) covers the pricing config, billing flows, and self-hosting on mainnet. The design is in [docs/](docs/README.md).

## In your backend

```bash
npm install @usenummo/sdk @usenummo/config   # Node 22.18+
```

```ts
import { Nummo } from "@usenummo/sdk";
const nummo = new Nummo(); // reads NUMMO_SECRET_KEY and NUMMO_API_URL

const { allowed } = await nummo.check({ customerId: "user_123", featureId: "premium_message", sendEvent: true });
if (!allowed) return showUpgrade();

const { checkoutUrl } = await nummo.attach({ customerId: "user_123", planId: "pro" });        // paid plan: wallet checkout
const { url } = await nummo.portal({ customerId: "user_123", returnUrl: "https://app.example/settings" }); // billing portal
```

Pricing is code (`nummo.config.ts`), applied with `npx nummo push`. Each paid plan version becomes one on-chain plan whose amount is its ceiling: base price plus overage cap plus automatic top-ups.

## Running it

Needs Node 22.18+ (TypeScript runs natively, no build step), pnpm and Docker.

```bash
pnpm install
pnpm db:up                                       # Postgres 18 on localhost:5434
pnpm build:web                                   # website and dashboard (apps/web)
pnpm dev:api                                     # API, website, dashboard, checkout and portal on http://localhost:8787
pnpm dev:worker                                  # renewals, overage, retries, top-ups, reconciliation, webhooks
```

Sign up at http://localhost:8787/sign-up, name your organization, and create a test key under **API keys**; then `pnpm nummo login --key nummo_sk_test_...`. For the website and dashboard with hot reload, run `pnpm dev:web` alongside the API and open http://localhost:5173.

Settlement needs a puller wallet in `NUMMO_TEST_PULLER_KEY` (see [.env.example](.env.example)); the [quickstart](docs/guide/quickstart.md) walks through it. For containers: `docker compose --profile app up --build`, or see [self-hosting](docs/guide/deploy.md).

## Layout

| Path | What |
| --- | --- |
| `packages/core` | Pure rules: exact quantities (bigint, 10^-9), money in base units, periods, deduction order, credit systems, overage and caps, proration. No I/O. |
| `packages/config` | `feature()`, `plan()`, `defineConfig()`, validation, top-ups, pay-per-use prices, per-model token pricing, and the on-chain terms each paid plan version needs. |
| `packages/db` | Drizzle schema and migrations, the hot path (every operation runs in one transaction holding the customer's row lock), subscription transitions, plan changes, top-ups, dashboard reports. |
| `packages/solana` | The `Chain` interface: read plans, records and authorities; build the activation, plan change, cancel, resume, top-up transfer and plan creation; prepare, send and confirm pulls. `SolanaChain` over `@solana/kit`, and `FakeChain`, an in-memory stand-in that follows the program's rules, for tests. |
| `packages/settlement` | Checkout, the settlement worker (renewals, overage, refills, safe resend), the failed-payment state machine, the reconciler, `verify`, the webhook dispatcher, and the customer portal. |
| `packages/agents` | Agent payments: Solana's `@solana/pay-kit` (x402 and MPP) in the API process, the puller as fee payer, a Postgres replay store, and recording paid requests in the ledger. |
| `packages/sdk` | TypeScript client. Fails open; queued `track` calls carry idempotency keys so a resend never double counts. `paywall` for agents (Hono middleware or fetch wrapper), `trackTokens` and `checkTokens` for model calls, `verifyWebhook` for receivers. |
| `packages/cli` | `nummo login`, `init`, `push`, `plans`, `plans publish`, `wallet`, `customers`, `preview`, `attach`, `portal`, `verify`. Run with `pnpm nummo` here, `npx nummo` elsewhere (published as `nummo`). |
| `apps/api` | Hono HTTP API (`/v1/...`), the hosted checkout (`/checkout/:id`), customer portal (`/portal/:id`), the dashboard's JSON API (`/dashboard/api`), accounts with Better Auth (`/api/auth`), and the built web app. |
| `apps/web` | The website (`/`) and merchant dashboard (`/dashboard`): React, Vite, Tailwind and shadcn/ui, with efferd's dashboard blocks and React Bits effects. |
| `apps/worker` | Runs settlement, reconciliation and webhook delivery on their own cadences. |
| `apps/demo` | AI chat demo that gates messages on credits, upgrades through checkout, buys credits, and opens the portal; `/agent/chat` for agents paying per request, `/api/complete` priced per token, and `src/agent.ts`, an agent that pays. |
| `e2e` | Scripted devnet scenarios: `devnet.ts` (M2), `devnet-m3.ts` (M3) and `devnet-m4.ts` (M4). |
| `scripts` | `build-packages.ts` (builds the npm packages to `dist/`) and `backup/` (the nightly off-site database dump and its restore script). |
| `spikes` | Throwaway devnet experiments (S1 to S3). |

## Tests

```bash
pnpm test:unit                 # core, config, FakeChain, settings; fast-check property tests
FC_NUM_RUNS=5000 pnpm test:unit
pnpm test:db                   # against Postgres (database nummo_test): hot path, concurrency, settlement, M3 flows, API, agent payments
pnpm typecheck

node e2e/devnet.ts run         # M2 on devnet, about 2 minutes; needs the funded wallets in spikes/.keys
node e2e/devnet.ts renewal     # after the scenario's 1-hour period ends
node e2e/devnet-m3.ts          # M3 on devnet, about 1 minute
node e2e/devnet-m4.ts          # M4 on devnet, about 20 seconds; needs e2e/.keys/agent.json holding devnet USDC (faucet.circle.com)
node e2e/checkout-page.ts      # serves a live devnet checkout on :8790 for a browser test
```

The db suite and the devnet scripts use their own databases (`nummo_test`, `nummo_e2e`), created on first run, because a worker settles every org in an environment.

## Publishing the packages

Five packages go to npm: `@usenummo/core`, `@usenummo/config`, `@usenummo/sdk`, `@usenummo/solana`, and the CLI as `nummo`. The rest (db, settlement, agents, the apps) are the server, which you run from this repository. Inside the workspace everything runs from `src/`; `pnpm build:packages` writes each package's `dist/` (JavaScript and type declarations), and `publishConfig` points the published copies at it.

```bash
npm login                          # once; the @usenummo scope needs a free npm organization named usenummo
pnpm build:packages
pnpm -r publish --dry-run          # lists each tarball's files
pnpm -r publish                    # in dependency order; replaces workspace:* with real versions
```

To release again, bump `version` in the five `package.json` files (keep them equal) and repeat.

## Licence

[Apache-2.0](LICENSE).
