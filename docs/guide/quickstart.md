# Quickstart: charge a devnet wallet

By the end you will have nummo running locally, a paid plan published on Solana devnet, and a browser wallet subscribed to it with one signature. Most of the time goes on the faucets. Expect 20 to 30 minutes.

Nothing here uses real money: devnet SOL and devnet USDC are free test tokens.

## What you need

- Node 22.18 or newer, pnpm, and Docker.
- A Solana browser wallet: Phantom, Solflare or Backpack, switched to **devnet** in its settings, with **two accounts**: one acts as the merchant, the other as a customer.

## 1. Install and start Postgres

```bash
git clone https://github.com/ommgh/nummo.git && cd nummo
pnpm install
pnpm db:up            # Postgres on localhost:5434
cp .env.example .env
```

## 2. Create the puller wallet

The puller is a hot wallet the server holds. It collects payments (only into the merchant's wallet, never elsewhere) and pays network fees and rent, so customers need no SOL.

```bash
mkdir -p keys
pnpm nummo wallet new keys/puller.json
```

Fund it with devnet SOL: paste the address it printed into https://faucet.solana.com and request 0.5 SOL. Then point the server at it by uncommenting this line in `.env`:

```bash
NUMMO_TEST_PULLER_KEY=./keys/puller.json
```

`pnpm nummo wallet balance keys/puller.json` shows what arrived.

## 3. Fund your browser wallet

- **Merchant account:** devnet SOL from https://faucet.solana.com (0.1 is plenty). It pays rent for the on-chain plan.
- **Customer account:** devnet USDC from https://faucet.circle.com (choose Solana Devnet). It needs no SOL.

## 4. Start nummo

```bash
pnpm build:web                                   # the website and dashboard (once, or after changing apps/web)
pnpm dev:api                                     # http://localhost:8787
```

Open http://localhost:8787/sign-up, create an account and name your organization. On the dashboard, go to **API keys**, click **New test key** and copy it (it is shown once):

```bash
pnpm nummo login --key nummo_sk_test_...         # the CLI remembers it
```

In a second terminal:

```bash
pnpm dev:worker       # renewals, overage, retries, top-ups, reconciliation, webhooks
```

## 5. Push a pricing config

Use the demo's config (Free, Pro at 20 USDC every 30 days, Team at 50, credit top-ups), or write your own with `pnpm nummo init`:

```bash
pnpm nummo push --config apps/demo/nummo.config.ts
```

The CLI shows what will change and asks before applying. See [Pricing config](pricing-config.md) for every option.

## 6. Publish the paid plans on-chain

Open http://localhost:8787/dashboard, go to **Plans**, and click **Publish with wallet** next to `pro@1`. Approve it with the **merchant** account. Do the same for `team@1`.

Each click creates a Solana Subscriptions plan owned by your merchant account. Its amount is the most a customer can ever be charged per period (base price plus overage cap), and it cannot change afterwards. That is why a price change needs a new plan version.

Prefer a keypair file? `pnpm nummo plans publish --keypair merchant.json` does the same.

## 7. Charge the customer

Start the demo chat app with the same key:

```bash
NUMMO_SECRET_KEY=nummo_sk_test_... pnpm --filter @usenummo/demo dev   # http://localhost:3000
```

Send a few messages (each one spends credits), then click **Upgrade to Pro**. On the checkout page, pick your wallet, switch to the **customer** account, and approve. One signature creates the subscription and pays the first 20 USDC; the customer spends no SOL.

No demo? Do it from the CLI instead:

```bash
pnpm nummo attach alice pro    # prints a checkout link; open it in the browser
```

## 8. Look around

- **Dashboard** (http://localhost:8787/dashboard): the payment with its transaction link, the customer, usage.
- **Customer portal**: `pnpm nummo portal <customer id>` prints a link. From there the customer can switch to Team (prorated, one signature), buy credits, see receipts, or cancel with their wallet.
- **Verify**: `pnpm nummo verify` compares nummo's records with the chain and exits 1 on any drift.

## Next

- [Billing flows](billing-flows.md): upgrades, downgrades, top-ups, failed payments, webhooks.
- [Self-hosting and mainnet](deploy.md): Docker, settings, and the checklist before real money.
- Integrate the SDK in your own backend: `check` before an action, `track` after it, `attach` to sell a plan. The demo's `apps/demo/src/server.ts` is about 60 lines of it.

## When something goes wrong

| Symptom | Cause |
| --- | --- |
| `settlement_unavailable` | `NUMMO_TEST_PULLER_KEY` is not set, or the API was started before you set it. |
| `plan_not_published` from `attach` | Step 6 was skipped for that plan version. |
| "This wallet has no USDC account" on checkout | The customer account has not received devnet USDC yet. |
| A wallet shows a mainnet warning or fails to sign | The wallet is not switched to devnet. |
| HTTP 429 in the logs | The public devnet RPC rate-limits. nummo retries; for heavier use set `NUMMO_TEST_RPC_URL` to a provider's endpoint. |
