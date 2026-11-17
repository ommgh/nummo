// The pricing config from docs/04-api-and-config.md. Apply with: pnpm --filter @bill/demo push
import { defineConfig, feature, plan, usdc } from "@bill/config";

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

export default defineConfig({
  mint: "USDC",
  features: [sso, basicMessage, premiumMessage, credits],
  plans: [free, pro],
});
