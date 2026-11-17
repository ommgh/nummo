// Pricing for the M3 devnet scenarios: hourly plans so changes can be watched.
// Pro 2 USDC/h (ceiling 7), Team 5 USDC/h (ceiling 10), Refill 1 USDC/h with an
// automatic top-up of 100 credits for 1 USDC at most twice a period (ceiling 3),
// and one-off top-ups at 1 USDC per 100 credits.
import { defineConfig, feature, plan, usdc } from "@usenummo/config";

const message = feature({ id: "message", type: "metered" });
const credits = feature({ id: "credits", type: "credit_system", rates: [{ feature: "message", credits: 1 }] });
const overage = { price: usdc("0.01"), per: 1, cap: usdc("5") };

export default defineConfig({
  features: [message, credits],
  plans: [
    plan({ id: "free", version: 1, name: "Free", default: true, items: [{ feature: "credits", included: 10, reset: "30d" }] }),
    plan({ id: "pro", version: 1, name: "Pro (hourly)", price: { amount: usdc("2"), period: "1h" }, items: [{ feature: "credits", included: 100, reset: "period", overage }] }),
    plan({ id: "team", version: 1, name: "Team (hourly)", price: { amount: usdc("5"), period: "1h" }, items: [{ feature: "credits", included: 500, reset: "period", overage }] }),
    plan({
      id: "refill",
      version: 1,
      name: "Refill (hourly)",
      price: { amount: usdc("1"), period: "1h" },
      items: [{ feature: "credits", included: 10, reset: "period", autoTopUp: { below: 5, quantity: 100, price: usdc("1"), maxPerPeriod: 2 } }],
    }),
  ],
  topUps: [{ feature: "credits", price: usdc("1"), per: 100 }],
});
