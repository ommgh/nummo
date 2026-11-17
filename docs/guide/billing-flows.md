# Billing flows

What happens to a customer, and what your backend calls. All examples use the TypeScript SDK; every call has a REST equivalent listed in [doc 04](../04-api-and-config.md).

```ts
import { Nummo } from "@usenummo/sdk";
const nummo = new Nummo(); // NUMMO_SECRET_KEY, NUMMO_API_URL
```

## Gating and metering

```ts
const { allowed } = await nummo.check({ customerId, featureId: "premium_message", sendEvent: true });
if (!allowed) return upgradePrompt();
```

`check` with `sendEvent: true` checks and records usage in one call. Use `check` then `track` when the cost is known only afterwards, or a lock (`check` with `lock`, then `balances.finalize`) when it must be reserved first. The SDK fails open if the API is unreachable and resends queued usage exactly once.

## AI model calls

```ts
const ok = await nummo.checkTokens({ customerId, model: "claude-sonnet-5-5", usage: { input: promptTokens, output: maxTokens } });
if (!ok.allowed) return upgradePrompt();
const res = await callModel();
await nummo.trackTokens({
  customerId,
  model: "claude-sonnet-5-5",
  usage: { input: res.usage.input_tokens, output: res.usage.output_tokens, cachedInput: res.usage.cache_read_input_tokens },
  idempotencyKey: res.id,
});
```

`trackTokens` records one usage event per kind of token at the model's credit rate ([pricing config](pricing-config.md#per-model-token-pricing)), in one transaction; an idempotency key covers all of them. `checkTokens` converts the whole call into one requirement against the shared balance.

## Agents paying per request

```ts
const gate = nummo.paywall({
  featureId: "premium_message",
  identify: (req) => sessionUserId(req),   // your signed-in user, or undefined for an agent
});

app.post("/agent/chat", gate.hono(), handler);                       // Hono
export const POST = gate.fetch(async (req, grant) => Response.json(...)); // Next.js route handlers, Workers, Bun
const r = await gate.check(request);                                   // anything with web Requests
```

For each request:

1. A signed-in customer with the balance is served from it, and the usage is tracked. No payment.
2. Anyone else gets `402 Payment Required` offering both x402 (`exact`, the `PAYMENT-REQUIRED` header) and MPP (`charge`, `WWW-Authenticate: Payment`), at the `payPerUse` price.
3. A request carrying a payment is verified and settled, then served, with the receipt header added to your response. Your puller wallet pays the network fee, so the agent needs only USDC.

A paid request is recorded like any other payment: an invoice of kind `pay_per_use`, a payment with its transaction signature and protocol, and a usage event. It belongs to the signed-in customer if there is one, otherwise to the paying wallet as customer `wallet:<address>`, which starts on no plan. Those customers appear in the dashboard beside your subscribers, marked "Agent". A credential is accepted once: a replayed x402 or MPP payment gets a new 402.

Only payment headers reach nummo (`payment-signature`, `x-payment`, `accept`, and `authorization` when it starts with `Payment`), never your own bearer tokens. If nummo is unreachable, a signed-in customer is served (fail open, unless the feature is in `failClosed`) and an agent gets a 503.

Verification and settlement use Solana's own [`@solana/pay-kit`](https://github.com/solana-foundation/pay-kit), in the nummo API process; nummo does not run a facilitator for anyone else. Payments settle in USDC only. `apps/demo/src/agent.ts` is a working agent: `node src/agent.ts <keypair.json> 4` pays the demo four times, alternating x402 and MPP, with spend limits (this origin, devnet, 0.05 USDC a payment).

## Subscribing

```ts
const { checkoutUrl } = await nummo.attach({ customerId, planId: "pro", successUrl });
```

A free plan attaches at once. A paid plan returns a checkout link. There the customer connects a wallet and signs one transaction: it creates the on-chain subscription at the plan's ceiling and pays the first base fee. Fees and rent are paid by your puller wallet, so the customer needs USDC and no SOL.

## Changing plans

Call `attach` with the new plan. `preview` tells you first what will happen:

```ts
const p = await nummo.preview({ customerId, planId: "team" });
// { change: "upgrade", dueNow: "45.5", credit: "4.5", effectiveAt: now, signatureRequired: true }
```

| Change | When | What the customer does |
| --- | --- | --- |
| Upgrade: the new plan costs at least as much per hour | Now | Signs once at checkout: subscribe to the new plan, pay its base fee less a credit for the unused part of the current period, and cancel the old plan. |
| Downgrade: cheaper, or to a free plan | At the end of the current period | Nothing now. At the period end a free plan starts at once; a paid one becomes a checkout to sign (shown in the portal), and the customer is on the default plan until they sign. |
| The current plan again | — | Cancels a scheduled downgrade. |

Why not instant downgrades or merchant-side cancels? Ending an on-chain subscription immediately needs the merchant's key, which nummo's server never holds, and a new subscription's periods start when it is signed. After an upgrade the old subscription stops granting credits at once but stays open until its period ends, so overage already used on it can still be collected; it is never renewed.

Changes are refused (`plan_change_blocked`) while a payment on the current plan is failing or still being collected.

## Top-ups

```ts
const { checkoutUrl, quantity } = await nummo.topUp({ customerId, featureId: "credits", amount: usdc("10") });
```

A one-off purchase at the price in your config: the customer signs a plain transfer, and the balance is granted when it confirms. Automatic top-ups need no call: they are pulled from the subscription when the balance drops below the plan's threshold, within the ceiling the customer already signed.

## The customer portal

```ts
const { url } = await nummo.portal({ customerId, returnUrl: "https://app.example.com/settings" });
```

Create a link each time a signed-in customer opens billing; it lasts an hour. The portal shows the plan, the on-chain ceiling, when it renews, usage with plan and purchased credits apart, and receipts with a link to each transaction. The customer can change plans, buy credits, and cancel or resume, signing with their own wallet.

## Failed payments

When a pull fails for lack of USDC the subscription becomes `past_due`, keeps its entitlements, and cannot accrue overage. Retries follow `NUMMO_RETRY_SCHEDULE` (default 1, 6, 24 and 72 hours after the first failure). If the last one fails the subscription ends and the customer falls back to the default plan. A period that passes unpaid cannot be charged later: that is how the on-chain program works.

## Webhooks

```ts
const { endpoint } = await nummo.webhooks.set("https://app.example.com/hooks/nummo"); // keep endpoint.secret
```

Events are signed (`X-Nummo-Signature`, checked with `verifyWebhook` from the SDK) and retried with backoff. The full list is in [doc 04](../04-api-and-config.md#webhook-events); the ones M3 added are `subscription.change_scheduled`, `subscription.canceled` with `reason: "replaced"` after an upgrade, `subscription.ended` with `next` when a scheduled plan takes over, and `kind: "topup"` on `invoice.finalized` and `payment.succeeded`.

## Checking the books

`nummo verify` (or `GET /v1/verify`) compares every published plan and live subscription with the chain: terms, wallet, cancellation, period start, and the amount collected this period against what the program counted. It exits 1 on drift. Run it after anything unusual, and in a scheduled job.
