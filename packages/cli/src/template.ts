/** What `nummo init` writes: the doc 04 example, with a top-up. */
export const CONFIG_TEMPLATE = `// Pricing as code. Apply with \`nummo push\`; paid plans then need \`nummo plans publish\`.
// Reference: https://github.com/ommgh/nummo/blob/master/docs/guide/pricing-config.md
import { defineConfig, feature, plan, usdc } from "@usenummo/config";

export const basicMessage = feature({ id: "basic_message", type: "metered" });
export const premiumMessage = feature({ id: "premium_message", type: "metered" });

// One balance that several features draw from at different rates.
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

// Changing the price, period or overage terms needs a new version: they become the on-chain plan the customer signs.
export const pro = plan({
  id: "pro",
  version: 1,
  name: "Pro",
  price: { amount: usdc("20"), period: "30d" },
  items: [{ feature: credits.id, included: 1000, reset: "period", overage: { price: usdc("0.01"), per: 1, cap: usdc("50") } }],
});

export default defineConfig({
  features: [basicMessage, premiumMessage, credits],
  plans: [free, pro],
  // One-off purchases: 1 USDC buys 100 credits.
  topUps: [{ feature: credits.id, price: usdc("1"), per: 100 }],
});
`;
