// Pricing for the devnet scenarios: a short period so renewal can be watched.
// Pro: 2 USDC per hour, 100 credits per period, overage 0.01 USDC per credit
// capped at 5 USDC, so the on-chain ceiling is 7 USDC per hour.
import { defineConfig, feature, plan, usdc } from "@usenummo/config";

const message = feature({ id: "message", type: "metered" });
const credits = feature({ id: "credits", type: "credit_system", rates: [{ feature: "message", credits: 1 }] });

export default defineConfig({
  mint: "USDC",
  features: [message, credits],
  plans: [
    plan({ id: "free", version: 1, name: "Free", default: true, items: [{ feature: "credits", included: 10, reset: "30d" }] }),
    plan({
      id: "pro",
      version: 1,
      name: "Pro (hourly)",
      price: { amount: usdc("2"), period: "1h" },
      items: [{ feature: "credits", included: 100, reset: "period", overage: { price: usdc("0.01"), per: 1, cap: usdc("5") } }],
    }),
  ],
});
