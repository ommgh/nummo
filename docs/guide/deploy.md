# Self-hosting and mainnet

nummo is two processes and a Postgres database:

| Process | Command | Does |
| --- | --- | --- |
| API | `node apps/api/src/server.ts` | `/v1` API, hosted checkout, customer portal, the website and merchant dashboard (built from `apps/web`), accounts at `/api/auth`. Applies migrations on start. |
| Worker | `node apps/worker/src/main.ts` | Renewals, overage and top-up pulls, retries, reconciliation with the chain, webhook delivery. Safe to run two: each job takes a Postgres advisory lock. |

Node runs the TypeScript directly. The one build step is the website and dashboard: `pnpm build:web` writes `apps/web/dist`, which the API serves. The Dockerfile does it for you.

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

## Railway

The hosted demo runs on Railway as one project with three services: `Postgres` (Railway's template), `api` and `worker`. The api and worker both build from this repository's Dockerfile and redeploy on every push to `master`.

| Service | Settings |
| --- | --- |
| `api` | Public domain on port 8787, healthcheck `/health`. Variables: `PORT=8787` (Railway otherwise injects 8080), `BETTER_AUTH_SECRET`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `NUMMO_PUBLIC_URL` (the public domain), `NUMMO_TEST_PULLER_KEY` (JSON byte array), `NUMMO_TEST_RPC_URL`. |
| `worker` | Start command `node apps/worker/src/main.ts`, restart always. Same variables plus `MIGRATE_ON_START=0`. |

Sign up at `/sign-up` on the public domain, name the organization and create keys under **API keys**. To give an org made earlier with the bootstrap script an owner, sign up first, then:

```bash
railway ssh --service api -- node apps/api/src/bootstrap.ts --org org_... --owner you@example.com
```

Expect about 5 to 10 USD a month on the Hobby plan: three small always-on processes. Add `NUMMO_LIVE_*` variables only after the mainnet checklist below.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | local | Postgres connection string. |
| `PORT` | 8787 | API port. |
| `BETTER_AUTH_SECRET` | — | **Required in production.** Signs dashboard sessions; 32+ random bytes (`openssl rand -base64 32`). Changing it signs everyone out. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | — | Offer "Continue with GitHub". Callback URL: `<NUMMO_PUBLIC_URL>/api/auth/callback/github`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | Offer "Continue with Google". Callback URL: `<NUMMO_PUBLIC_URL>/api/auth/callback/google`. |
| `NUMMO_TRUSTED_ORIGINS` | — | Extra origins (comma-separated) allowed to call `/api/auth`, for a dashboard served from another domain. |
| `NUMMO_PUBLIC_URL` | `http://localhost:8787` | Public base URL: checkout, portal and plan metadata links. Use `https://` in production; the dashboard cookie is then marked Secure. |
| `NUMMO_TEST_PULLER_KEY`, `NUMMO_LIVE_PULLER_KEY` | — | Puller keypair (file path or JSON byte array) per environment. Without one, that environment's settlement and agent payments are off. The puller also pays the network fee of each x402 and MPP payment (about 0.00001 SOL). |
| `NUMMO_MPP_SECRET` | derived from the puller key | Binds MPP challenges to their contents. Set it explicitly if you rotate the puller key. |
| `NUMMO_MPP_REALM` | `nummo` | The realm in MPP challenges. |
| `NUMMO_TEST_RPC_URL`, `NUMMO_LIVE_RPC_URL` | public cluster | RPC endpoint. Use a provider's on mainnet. |
| `NUMMO_TEST_MINT`, `NUMMO_LIVE_MINT` | USDC | Token mint. Mainnet refuses anything but USDC unless `NUMMO_LIVE_ALLOW_MINT` names it too. |
| `NUMMO_TEST_PRIORITY_FEE`, `NUMMO_LIVE_PRIORITY_FEE` | 0, 10000 | Micro-lamports per compute unit. |
| `NUMMO_SETTLEMENT_THRESHOLD` | 5 | USDC of overage accrued before it is pulled mid-period. |
| `NUMMO_RETRY_SCHEDULE` | `1h,6h,24h,72h` | Retries after a failed pull. Keep the last one shorter than your shortest billing period. |
| `NUMMO_SETTLE_EVERY`, `NUMMO_RECONCILE_EVERY` | 10s, 2m | Worker cadences. |
| `MIGRATE_ON_START` | 1 | Set to 0 on all but one process if you migrate separately. |
| `MAIL_FROM` | — | Sender of account email, e.g. `nummo <no-reply@example.com>`. Needed with either transport below. |
| `RESEND_API_KEY` | — | Send email through Resend's HTTP API. Needs a domain verified in Resend. |
| `SMTP_URL` | — | Or send through any SMTP server: `smtps://user:pass@smtp-relay.brevo.com:465`. Without either, reset emails are printed to the console in development and dropped (with a warning) in production. |
| `NUMMO_RATE_LIMIT_API` | 100 | Requests per second per org and environment on `/v1` (burst twice that). |
| `NUMMO_RATE_LIMIT` | on | `off` turns every API rate limit off. |
| `NUMMO_CLIENT_IP_HEADER` | `x-real-ip` | Header with the client's address, for per-IP limits. Railway's edge sets `X-Real-IP`. Set it empty when the API faces the internet with no proxy in front, or clients can forge it. |
| `NUMMO_ALERT_WEBHOOK_URL` | — | Worker alerts (low puller SOL, a loop failing three times in a row) go to this Discord or Slack webhook, ntfy.sh topic, or JSON endpoint. |
| `NUMMO_ALERT_MIN_SOL` | 0.05 | Alert when a puller holds less SOL than this. |
| `NUMMO_HEARTBEAT_URL` | — | The worker GETs this at most once a minute after a settlement pass: point it at a dead-man's switch (Healthchecks.io) to hear when the worker stops. |

Test keys (`nummo_sk_test_…`) settle on devnet, live keys (`nummo_sk_live_…`) on mainnet, with separate data. The dashboard has a Test/Live switch, and owners and admins create both kinds of key under **API keys**.

Rate limits (per IP unless noted): `/v1` 100 requests a second per org with a burst of 200, and 10 wrong-key attempts a minute; checkout, portal and plan metadata reads 120 a minute; checkout and portal writes 20 a minute; the dashboard API 300 a minute. Better Auth limits sign-in to 3 attempts per 10 seconds and reset requests to 3 a minute. Refusals are `429 rate_limited` with `Retry-After`; the SDK treats them like an outage, so `check` fails open and `track` is queued and resent. The counters live in the API process, so with several API replicas each keeps its own.

## Email

Accounts send one email today: the password reset link (valid one hour, once; it signs out every other session). Pick a provider:

| Provider | Free tier | Needs | Use |
| --- | --- | --- | --- |
| [Brevo](https://www.brevo.com/free-smtp-server/) | 300 emails a day | A verified sender address; no domain needed | Start here if you have no domain: `SMTP_URL=smtp://<login>:<smtp key>@smtp-relay.brevo.com:587` |
| [Resend](https://resend.com/pricing) | 3,000 a month, 100 a day | A domain you can add DNS records to | Best developer experience once you own a domain: `RESEND_API_KEY` |
| Gmail SMTP | about 500 a day | An app password on a Google account with 2-step verification | Fine for testing; mail comes from a gmail.com address |
| Amazon SES | pay per use, about 0.10 USD per 1,000 | A domain and leaving the SES sandbox | Cheapest at volume |

## Monitoring and alerts

Free, layered, nothing to run yourself:

| What can go wrong | What tells you | Set up |
| --- | --- | --- |
| A deploy fails, or a service crashes and Railway stops restarting it | Railway emails project members (built in). Add a project webhook to Discord for a phone push. | Railway: Project settings → Webhooks |
| The API or its database is down | [UptimeRobot](https://uptimerobot.com/) free plan: 50 monitors every 5 minutes, email alerts | Monitor `https://<api>/health/deep` (checks the database and answers 503 if it is down) |
| The worker died or hangs | [Healthchecks.io](https://healthchecks.io/) free plan (20 checks): alerts when the worker's pings stop | Create a check with a 5-minute period, set `NUMMO_HEARTBEAT_URL` on the worker |
| The puller runs out of SOL, or the RPC or database keeps failing | The worker's own alerts | `NUMMO_ALERT_WEBHOOK_URL` on the worker: a Discord webhook, or `https://ntfy.sh/<a long random topic>` with the ntfy phone app |
| Payments or webhooks misbehave | The dashboard, and `nummo verify` | Run `nummo verify` after anything unusual |
| The nightly backup did not run | Healthchecks.io | A second check, set as `BACKUP_HEARTBEAT_URL` on the backup job |

Railway's Observability tab shows logs, CPU and memory on every plan; its threshold monitors need the Pro plan. Error tracking (Sentry's free plan, 5,000 errors a month) is worth adding once real users arrive.

## Backups

Two layers:

1. **Railway volume backups** of the Postgres volume, daily (kept 6 days) and weekly (kept 27 days). Turn them on once, and take one by hand before risky changes:

   ```bash
   railway postgres pitr schedule set --daily --weekly --service Postgres
   railway postgres pitr backup create --name before-migration --service Postgres
   railway postgres pitr backup list --service Postgres     # restore: railway postgres pitr backup restore
   ```

   They live in Railway, so they do not help if the project or account is lost.

2. **A nightly logical dump off Railway**, with `scripts/backup`: `pg_dump`, checked with `pg_restore --list`, optionally encrypted with AES-256, uploaded to any S3-compatible bucket, dumps older than 30 days pruned. [Cloudflare R2](https://developers.cloudflare.com/r2/pricing/) (10 GB free, no egress fees) or Backblaze B2 (10 GB free) cost nothing at this size. On Railway, add a service from this repository with:

   | Setting | Value |
   | --- | --- |
   | Dockerfile path | `scripts/backup/Dockerfile` |
   | Cron schedule | `0 21 * * *` (daily, UTC) |
   | Restart policy | Never |
   | Variables | `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_PASSPHRASE` (keep a copy outside Railway: without it the dumps cannot be read), `BACKUP_HEARTBEAT_URL` |

   Restore into a new, empty database and check it before pointing anything at it:

   ```bash
   BACKUP_PASSPHRASE=... scripts/backup/restore.sh nummo-2026-11-18T210000Z.dump.enc postgres://.../nummo_restore
   ```

   Rehearse a restore every few months: an untested backup is a guess.

## Keys and custody

- The **merchant wallet** owns the on-chain plans and receives every payment. Its key never touches the server: plans are published from the dashboard with a browser wallet or from the CLI on your machine.
- The **puller** is a hot wallet on the server. It can only pull into the merchant's wallet (the plan's destination list) and only up to each customer's signed ceiling. Keep just enough SOL in it for fees and rent: about 0.0027 SOL per new subscriber, and a few thousand lamports per pull.

## Before real money: mainnet checklist

1. Switch the dashboard to **Live** and create a live key under **API keys**.
2. Set `NUMMO_LIVE_PULLER_KEY` to a **new** keypair (`nummo wallet new`), funded with a little mainnet SOL. Never reuse the devnet puller.
3. Set `NUMMO_LIVE_RPC_URL` to a provider's endpoint, and `NUMMO_PUBLIC_URL` to your HTTPS address.
4. Push the config with the live key, and publish the paid plans from a merchant wallet you control (a hardware wallet is a good idea). The ceiling you publish is permanent for that version: check it.
5. Start with small amounts: a plan priced at 1 USDC with a short period, subscribed from your own second wallet. Watch one renewal and run `nummo verify`.
6. Register a webhook endpoint and confirm deliveries in the dashboard.
7. Back up Postgres (above). The chain holds the money and the subscriptions, but the ledger (credits, usage, invoices) lives in your database.
8. Set `NUMMO_ALERT_WEBHOOK_URL` and `NUMMO_HEARTBEAT_URL` on the worker, and set `NUMMO_RECONCILE_EVERY=15m` unless you pay for RPC (below).

### Variables for live mode

On both `api` and `worker` (the worker needs no `BETTER_AUTH_SECRET`):

| Variable | Value |
| --- | --- |
| `NUMMO_LIVE_PULLER_KEY` | The new mainnet puller's keypair, as a JSON byte array. A secret: whoever holds it can spend the puller's SOL (not your customers' USDC, which the program only lets it move to your merchant wallet). |
| `NUMMO_LIVE_RPC_URL` | A mainnet RPC endpoint, e.g. Helius `https://mainnet.helius-rpc.com/?api-key=...`. The public endpoint rate-limits and is not for production. |
| `NUMMO_PUBLIC_URL` | Your HTTPS address (already set for test mode). |
| `NUMMO_LIVE_PRIORITY_FEE` | Optional; 10000 micro-lamports per compute unit by default. Raise it if pulls are slow to land when the network is busy. |
| `NUMMO_RECONCILE_EVERY` | `15m` on the free RPC tier (see costs). |

`NUMMO_LIVE_MINT` defaults to mainnet USDC; leave it unset. Then redeploy both services: the API log prints `live: settling on mainnet ...`.

### What mainnet costs

At about 74 USD per SOL (November 2026):

| Item | Cost | Paid by |
| --- | --- | --- |
| Hosting (Railway Hobby: api, worker, Postgres) | 5 USD a month minimum, which includes 5 USD of usage; expect 5 to 10 USD | You |
| Each new subscriber (rent for the on-chain records, plus fees) | 0.0026 SOL, about 0.20 USD, once | The puller |
| Each pull (renewal, overage, top-up) | about 0.000006 SOL with the default priority fee, well under 0.001 USD | The puller |
| Each agent payment (x402 or MPP) | about 0.00001 SOL | The puller |
| Publishing a plan version | a few thousandths of a SOL in rent | The merchant wallet |
| RPC | Helius free plan: 1M credits a month at 10 requests a second, then 49 USD a month | You |
| Email, uptime checks, heartbeats, off-site backups | 0 USD on the free tiers above | You |
| USDC to test with | whatever you charge yourself: 5 to 10 USD is plenty | Your test wallet (it comes back to your merchant wallet) |

Fund the puller with 0.1 SOL (about 7.50 USD) to start: that covers about 35 new subscribers and thousands of pulls. Keep only a little more than you need in it.

RPC use is driven by reconciliation, which reads each live subscription from the chain (about 2 calls) on every pass. Every 2 minutes, that is about 43,000 calls a month per subscriber, so the free 1M credits run out at about 23 subscribers. Every 15 minutes, it is about 5,800 a month per subscriber, or about 170 subscribers on the free plan. Settlement passes only touch the chain when a payment is due.

Stablecoin payments have tax and regulatory consequences that depend on where you and your customers are. nummo is non-custodial software and does not handle them; get professional advice before charging real customers.
