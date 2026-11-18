# @usenummo/sdk

TypeScript client for [nummo](https://github.com/ommgh/nummo): open-source usage billing and entitlements, settled in USDC on Solana.

```bash
npm install @usenummo/sdk
```

```ts
import { Nummo } from "@usenummo/sdk";
const nummo = new Nummo(); // reads NUMMO_SECRET_KEY and NUMMO_API_URL

const { allowed } = await nummo.check({ customerId: "user_123", featureId: "messages" });
if (!allowed) return showUpgrade();
await nummo.track({ customerId: "user_123", featureId: "messages", value: 1 });

const { checkoutUrl } = await nummo.attach({ customerId: "user_123", planId: "pro" }); // wallet checkout
const { url } = await nummo.portal({ customerId: "user_123" });                         // billing portal
```

- **Fails open.** If the API cannot be reached, `check` allows and `track` is queued and resent with its idempotency key, so nothing is counted twice. List features in `failClosed` to refuse them instead.
- **AI usage:** `trackTokens` and `checkTokens` charge model calls per token.
- **Agents:** `paywall` takes x402 and MPP payments per request (Hono middleware, fetch wrapper, or plain check).
- **Webhooks:** `verifyWebhook` checks the `X-Nummo-Signature` header.

Needs Node 22.18 or newer. Docs: the [guide](https://github.com/ommgh/nummo/tree/master/docs/guide). Licence: Apache-2.0.
