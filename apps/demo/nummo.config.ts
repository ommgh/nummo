// The pricing config from docs/04-api-and-config.md. Apply with: pnpm --filter @usenummo/demo push
import { defineConfig, feature, plan, usdc } from "@usenummo/config";

export const sso = feature({ id: "sso", type: "boolean" });
export const basicMessage = feature({ id: "basic_message", type: "metered", consumable: true });
export const premiumMessage = feature({ id: "premium_message", type: "metered", consumable: true });

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

export const pro = plan({
  id: "pro",
  version: 1,
  name: "Pro",
  price: { amount: usdc("20"), period: "30d" },
  items: [
    { feature: sso.id },
    { feature: credits.id, included: 1000, reset: "period", overage: { price: usdc("0.01"), per: 1, cap: usdc("50") } },
  ],
});

// Team: an upgrade from Pro is prorated and signed once; a move back is scheduled for the period end.
export const team = plan({
  id: "team",
  version: 1,
  name: "Team",
  price: { amount: usdc("50"), period: "30d" },
  items: [
    { feature: sso.id },
    { feature: credits.id, included: 5000, reset: "period", overage: { price: usdc("0.008"), per: 1, cap: usdc("100") } },
  ],
});

export default defineConfig({
  mint: "USDC",
  features: [sso, basicMessage, premiumMessage, credits],
  plans: [free, pro, team],
  // One-off purchases from the demo's "Buy credits" button and the portal: 1 USDC buys 100 credits.
  topUps: [{ feature: credits.id, price: usdc("1"), per: 100 }],
});
