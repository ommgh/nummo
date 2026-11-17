import { describe, expect, test } from "vitest";
import { ConfigError, defineConfig, feature, onchainTerms, plan, toDocument, usdc, validateDocument } from "../src/index.ts";

// The example from docs/04-api-and-config.md, verbatim.
const sso = feature({ id: "sso", type: "boolean" });
const basicMessage = feature({ id: "basic_message", type: "metered", consumable: true });
const premiumMessage = feature({ id: "premium_message", type: "metered", consumable: true });
const credits = feature({
  id: "credits",
  type: "credit_system",
  rates: [
    { feature: basicMessage.id, credits: 1 },
    { feature: premiumMessage.id, credits: 10 },
  ],
});
const free = plan({
  id: "free",
  version: 1,
  name: "Free",
  default: true,
  items: [{ feature: credits.id, included: 100, reset: "30d" }],
});
const pro = plan({
  id: "pro",
  version: 1,
  name: "Pro",
  price: { amount: usdc("20"), period: "30d" },
  items: [
    { feature: sso.id },
    { feature: credits.id, included: 1000, reset: "period", overage: { price: usdc("0.01"), per: 1, cap: usdc("50") } },
  ],
});
const example = defineConfig({ mint: "USDC", features: [sso, basicMessage, premiumMessage, credits], plans: [free, pro] });

describe("pricing config", () => {
  test("the doc 04 example is valid and serialises to strings", () => {
    const doc = toDocument(example);
    const p = doc.plans.find((x) => x.id === "pro")!;
    expect(p.price).toEqual({ amount: "20000000", periodHours: 720 });
    expect(p.items[1]).toEqual({
      feature: "credits",
      included: "1000",
      reset: "period",
      overage: { price: "10000", per: "1", cap: "50000000" },
      autoTopUp: null,
    });
    expect(doc.plans[0]!.items[0]!.reset).toBe(720);
    // Round-trips through JSON (what the CLI sends).
    expect(validateDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });

  test("the on-chain plan for pro v1 is 70 USDC every 720 hours (doc 04)", () => {
    const doc = toDocument(example);
    expect(onchainTerms(doc.plans.find((x) => x.id === "pro")!)).toEqual({ amount: usdc("70"), periodHours: 720 });
    expect(onchainTerms(doc.plans.find((x) => x.id === "free")!)).toBeNull();
  });

  const invalid = (cfg: Parameters<typeof toDocument>[0]) => {
    try {
      toDocument(cfg);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      return (e as ConfigError).issues.join("\n");
    }
    throw new Error("expected the config to be rejected");
  };

  test.each([
    ["unknown feature in a plan", { features: [], plans: [{ ...free, items: [{ feature: "nope", included: 1, reset: "30d" as const }] }] }, "unknown feature"],
    ["paid default plan", { features: [sso], plans: [{ ...pro, default: true, items: [{ feature: "sso" }] }] }, "must be free"],
    ["reset period on a free plan", { features: [credits, basicMessage, premiumMessage], plans: [{ ...free, items: [{ feature: "credits", included: 5, reset: "period" as const }] }] }, 'needs a paid plan'],
    ["overage without price", { features: [credits, basicMessage, premiumMessage], plans: [{ ...free, default: false, items: [{ feature: "credits", included: 5, reset: "30d" as const, overage: { price: 1n, cap: 10n } }] }] }, "needs a price"],
    ["credit rate for a boolean", { features: [sso, { id: "c", type: "credit_system" as const, rates: [{ feature: "sso", credits: 1 }] }], plans: [] }, "must be a metered feature"],
    ["feature in two credit systems", { features: [basicMessage, { id: "a", type: "credit_system" as const, rates: [{ feature: "basic_message", credits: 1 }] }, { id: "b", type: "credit_system" as const, rates: [{ feature: "basic_message", credits: 2 }] }], plans: [] }, "two credit systems"],
    ["duplicate plan version", { features: [sso], plans: [{ ...pro, items: [{ feature: "sso" }] }, { ...pro, items: [{ feature: "sso" }] }] }, "declared twice"],
    ["calendar month", { features: [sso], plans: [{ ...pro, price: { amount: 1n, period: "1m" as never }, items: [] }] }, "period"],
    ["bad id", { features: [{ id: "Premium Message", type: "boolean" as const }], plans: [] }, "lowercase"],
    ["zero overage cap", { features: [credits, basicMessage, premiumMessage], plans: [{ ...pro, items: [{ feature: "credits", included: 1, reset: "period" as const, overage: { price: 1n, cap: 0n } }] }] }, "greater than 0"],
    ["auto top-up on a free plan", { features: [credits, basicMessage, premiumMessage], plans: [{ ...free, items: [{ feature: "credits", included: 5, reset: "30d" as const, autoTopUp: { below: 1, quantity: 10, price: 1n, maxPerPeriod: 1 } }] }] }, "needs a paid plan"],
    ["auto top-up on a metered feature inside a credit system", { features: [credits, basicMessage, premiumMessage], plans: [{ ...pro, items: [{ feature: "basic_message", included: 5, reset: "period" as const, autoTopUp: { below: 1, quantity: 10, price: 1n, maxPerPeriod: 1 } }] }] }, "put the automatic top-up on that"],
    ["top-up of a boolean", { features: [sso], plans: [], topUps: [{ feature: "sso", price: 1n }] }, "no balance"],
    ["top-up of an unknown feature", { features: [], plans: [], topUps: [{ feature: "credits", price: 1n }] }, "unknown feature"],
    ["top-up with min above max", { features: [credits, basicMessage, premiumMessage], plans: [], topUps: [{ feature: "credits", price: 1n, min: 10n, max: 5n }] }, "min <= max"],
    ["payTo that is not an address", { features: [], plans: [], payTo: "not-a-wallet" }, "base58"],
  ])("rejects %s", (_name, cfg, message) => {
    expect(invalid(cfg)).toContain(message);
  });

  test("automatic top-ups add their most per period to the on-chain ceiling", () => {
    const doc = toDocument({
      ...example,
      plans: [
        free,
        {
          ...pro,
          items: [
            { feature: "sso" },
            {
              feature: "credits",
              included: 1000,
              reset: "period",
              overage: { price: usdc("0.01"), per: 1, cap: usdc("50") },
              autoTopUp: { below: 100, quantity: 1000, price: usdc("10"), maxPerPeriod: 3 },
            },
          ],
        },
      ],
    });
    // 20 base + 50 overage cap + 3 x 10 top-ups
    expect(onchainTerms(doc.plans[1]!)).toEqual({ amount: usdc("100"), periodHours: 720 });
    expect(doc.plans[1]!.items[1]!.autoTopUp).toEqual({ below: "100", quantity: "1000", price: "10000000", maxPerPeriod: 3 });
  });

  test("one-off top-ups default to 1 per unit, between 1 and 1,000 USDC", () => {
    const doc = toDocument({ ...example, payTo: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", topUps: [{ feature: "credits", price: usdc("1"), per: 100 }] });
    expect(doc.topUps).toEqual([{ feature: "credits", price: "1000000", per: "100", min: "1000000", max: "1000000000" }]);
    expect(doc.payTo).toBe("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
  });

  test("documents written before top-ups existed still validate", () => {
    const doc = JSON.parse(JSON.stringify(toDocument(example)));
    delete doc.topUps;
    delete doc.payTo;
    for (const p of doc.plans) for (const i of p.items) delete i.autoTopUp;
    expect(validateDocument(doc)).toEqual(toDocument(example));
  });
});
