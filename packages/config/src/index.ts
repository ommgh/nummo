/**
 * Pricing as config (doc 04). Merchants write `nummo.config.ts` with these
 * builders; the CLI serialises it with `toDocument` and sends it to
 * `PUT /v1/config`, where the same `validateDocument` runs again.
 */

import { z } from "zod";
import { type BaseUnits, formatQty, parseHours, qty, usdc } from "@usenummo/core";

export { usdc };

// ------------------------------------------------------------------ builder input

export type FeatureInput =
  | { id: string; name?: string; type: "boolean" }
  | { id: string; name?: string; type: "metered"; consumable?: boolean }
  | {
      id: string;
      name?: string;
      type: "credit_system";
      /** Credits drawn per unit of each metered feature. */
      rates: { feature: string; credits: number | string }[];
    };

export type PlanItemInput = {
  feature: string;
  /** Included amount per reset. Omit for boolean features. */
  included?: number | string;
  /**
   * When the included amount is renewed: "period" (each billing period of a
   * paid plan), a duration such as "30d" or "12h", or "never".
   */
  reset?: "period" | "never" | `${number}d` | `${number}h`;
  overage?: {
    /** Price in base units per `per` units of the feature. */
    price: BaseUnits;
    per?: number | string;
    /** Most overage may cost in one billing period, in base units. Required: it is part of the on-chain ceiling. */
    cap: BaseUnits;
  };
  /**
   * Refill automatically when the balance drops below `below`: pull `price` from
   * the subscription and grant `quantity`, at most `maxPerPeriod` times a period.
   * `price * maxPerPeriod` is added to the on-chain ceiling, so no extra
   * signature is needed after activation (doc 04, top-ups).
   */
  autoTopUp?: {
    below: number | string;
    quantity: number | string;
    price: BaseUnits;
    maxPerPeriod: number;
  };
};

export type PlanInput = {
  id: string;
  version: number;
  name: string;
  /** The plan every new customer starts on. Must be free. */
  default?: boolean;
  isAddon?: boolean;
  /** Base price per period. Omit for a free plan. */
  price?: { amount: BaseUnits; period: `${number}d` | `${number}h` | number };
  items: PlanItemInput[];
};

/** A one-off purchase of a feature's balance: `price` base units buys `per` units. */
export type TopUpInput = {
  feature: string;
  price: BaseUnits;
  per?: number | string;
  /** Smallest and largest purchase, in base units. Default 1 USDC to 1,000 USDC. */
  min?: BaseUnits;
  max?: BaseUnits;
};

export type ConfigInput = {
  mint?: "USDC";
  /**
   * The merchant wallet that receives one-off top-up payments. Defaults to the
   * owner of the most recently published plan.
   */
  payTo?: string;
  features: FeatureInput[];
  plans: PlanInput[];
  topUps?: TopUpInput[];
};

export function feature<const F extends FeatureInput>(f: F): F {
  return f;
}

export function plan<const P extends PlanInput>(p: P): P {
  return p;
}

export function defineConfig(c: ConfigInput): ConfigInput {
  return c;
}

// ------------------------------------------------------------------ wire document

const id = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "ids are lowercase letters, digits and underscores, starting with a letter");
const decimal = z.string().regex(/^\d+(\.\d{1,9})?$/, "a non-negative decimal with up to 9 places");
const baseUnits = z.string().regex(/^\d+$/, "an integer number of base units");

export const featureDocSchema = z.discriminatedUnion("type", [
  z.object({ id, name: z.string().optional(), type: z.literal("boolean") }),
  z.object({ id, name: z.string().optional(), type: z.literal("metered"), consumable: z.boolean().default(true) }),
  z.object({
    id,
    name: z.string().optional(),
    type: z.literal("credit_system"),
    rates: z.array(z.object({ feature: id, credits: decimal })).min(1),
  }),
]);

export const planItemDocSchema = z.object({
  feature: id,
  included: decimal.nullable(),
  /** Hours between resets, "period", or "never". */
  reset: z.union([z.literal("period"), z.literal("never"), z.number().int().positive()]),
  overage: z.object({ price: baseUnits, per: decimal, cap: baseUnits }).nullable(),
  autoTopUp: z
    .object({ below: decimal, quantity: decimal, price: baseUnits, maxPerPeriod: z.number().int().positive().max(100) })
    .nullable()
    .default(null),
});

export const planDocSchema = z.object({
  id,
  version: z.number().int().positive(),
  name: z.string().min(1),
  default: z.boolean(),
  isAddon: z.boolean(),
  price: z.object({ amount: baseUnits, periodHours: z.number().int().positive() }).nullable(),
  items: z.array(planItemDocSchema),
});

export const topUpDocSchema = z.object({ feature: id, price: baseUnits, per: decimal, min: baseUnits, max: baseUnits });

const solanaAddress = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "a base58 Solana address");

export const configDocSchema = z.object({
  mint: z.literal("USDC"),
  payTo: solanaAddress.nullable().default(null),
  features: z.array(featureDocSchema),
  plans: z.array(planDocSchema),
  topUps: z.array(topUpDocSchema).default([]),
});

export type FeatureDoc = z.infer<typeof featureDocSchema>;
export type PlanItemDoc = z.infer<typeof planItemDocSchema>;
export type PlanDoc = z.infer<typeof planDocSchema>;
export type TopUpDoc = z.infer<typeof topUpDocSchema>;
export type ConfigDoc = z.infer<typeof configDocSchema>;

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`invalid pricing config:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** Serialise builder input into the JSON document the API accepts. Validates it. */
export function toDocument(input: ConfigInput): ConfigDoc {
  const issues: string[] = [];
  const attempt = <T>(what: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      issues.push(`${what}: ${(e as Error).message}`);
      return undefined;
    }
  };

  const doc = {
    mint: input.mint ?? "USDC",
    payTo: input.payTo ?? null,
    topUps: (input.topUps ?? []).map((t) => ({
      feature: t.feature,
      price: t.price.toString(),
      per: formatQty(qty(t.per ?? 1)),
      min: (t.min ?? usdc("1")).toString(),
      max: (t.max ?? usdc("1000")).toString(),
    })),
    features: input.features.map((f) =>
      f.type === "credit_system"
        ? { ...f, rates: f.rates.map((r) => ({ feature: r.feature, credits: formatQty(qty(r.credits)) })) }
        : f.type === "metered"
          ? { ...f, consumable: f.consumable ?? true }
          : f,
    ),
    plans: input.plans.map((p) => ({
      id: p.id,
      version: p.version,
      name: p.name,
      default: p.default ?? false,
      isAddon: p.isAddon ?? false,
      price: p.price
        ? {
            amount: p.price.amount.toString(),
            periodHours: attempt(`plan ${p.id} period`, () => parseHours(p.price!.period)) ?? 0,
          }
        : null,
      items: p.items.map((i) => ({
        feature: i.feature,
        included: i.included === undefined ? null : formatQty(qty(i.included)),
        reset:
          i.reset === undefined || i.reset === "period" || i.reset === "never"
            ? (i.reset ?? (i.included === undefined ? "never" : "period"))
            : (attempt(`plan ${p.id} item ${i.feature} reset`, () => parseHours(i.reset!)) ?? 0),
        overage: i.overage
          ? { price: i.overage.price.toString(), per: formatQty(qty(i.overage.per ?? 1)), cap: i.overage.cap.toString() }
          : null,
        autoTopUp: i.autoTopUp
          ? {
              below: formatQty(qty(i.autoTopUp.below)),
              quantity: formatQty(qty(i.autoTopUp.quantity)),
              price: i.autoTopUp.price.toString(),
              maxPerPeriod: i.autoTopUp.maxPerPeriod,
            }
          : null,
      })),
    })),
  };
  if (issues.length) throw new ConfigError(issues);
  return validateDocument(doc);
}

/** Parse and check a config document. Throws ConfigError listing every problem. */
export function validateDocument(raw: unknown): ConfigDoc {
  const parsed = configDocSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`));
  }
  const doc = parsed.data;
  const issues: string[] = [];
  const features = new Map<string, FeatureDoc>();

  for (const f of doc.features) {
    if (features.has(f.id)) issues.push(`feature ${f.id} is declared twice`);
    features.set(f.id, f);
  }

  const creditSystemOf = new Map<string, string>();
  for (const f of doc.features) {
    if (f.type !== "credit_system") continue;
    for (const r of f.rates) {
      const target = features.get(r.feature);
      if (!target) issues.push(`credit system ${f.id} has a rate for unknown feature ${r.feature}`);
      else if (target.type !== "metered") issues.push(`credit system ${f.id}: ${r.feature} must be a metered feature`);
      if (qty(r.credits) <= 0n) issues.push(`credit system ${f.id}: rate for ${r.feature} must be positive`);
      const prev = creditSystemOf.get(r.feature);
      if (prev && prev !== f.id) issues.push(`feature ${r.feature} is in two credit systems (${prev}, ${f.id})`);
      creditSystemOf.set(r.feature, f.id);
    }
  }

  const versions = new Set<string>();
  let defaults = 0;
  for (const p of doc.plans) {
    const where = `plan ${p.id} v${p.version}`;
    const key = `${p.id}@${p.version}`;
    if (versions.has(key)) issues.push(`${where} is declared twice`);
    versions.add(key);

    const paid = p.price !== null;
    const hasOverage = p.items.some((i) => i.overage !== null);
    if (p.default) {
      defaults++;
      if (paid || hasOverage) issues.push(`${where} is the default plan, so it must be free (no price, no overage)`);
      if (p.isAddon) issues.push(`${where}: an add-on cannot be the default plan`);
    }
    if (hasOverage && !paid) {
      issues.push(`${where} has overage, so it needs a price with a period (the amount may be 0)`);
    }

    const seen = new Set<string>();
    for (const i of p.items) {
      const f = features.get(i.feature);
      const iw = `${where} item ${i.feature}`;
      if (seen.has(i.feature)) issues.push(`${iw} appears twice`);
      seen.add(i.feature);
      if (!f) {
        issues.push(`${iw}: unknown feature`);
        continue;
      }
      if (f.type === "boolean") {
        if (i.included !== null || i.overage !== null) issues.push(`${iw}: a boolean feature takes no included amount or overage`);
        continue;
      }
      if (i.included === null) issues.push(`${iw}: included is required for ${f.type} features (use 0 for pay as you go)`);
      if (i.reset === "period" && !paid) issues.push(`${iw}: reset "period" needs a paid plan; use a duration such as "30d"`);
      if (i.overage) {
        if (qty(i.overage.per) <= 0n) issues.push(`${iw}: overage "per" must be positive`);
        if (BigInt(i.overage.cap) === 0n) issues.push(`${iw}: overage cap must be greater than 0`);
      }
      if (i.autoTopUp) {
        if (!paid) issues.push(`${iw}: automatic top-up is pulled from the subscription, so it needs a paid plan (the price may be 0)`);
        if (qty(i.autoTopUp.quantity) <= 0n) issues.push(`${iw}: automatic top-up quantity must be positive`);
        if (BigInt(i.autoTopUp.price) === 0n) issues.push(`${iw}: automatic top-up price must be greater than 0`);
        if (f.type === "metered" && creditSystemOf.has(f.id)) {
          issues.push(`${iw}: ${f.id} draws from credit system ${creditSystemOf.get(f.id)}; put the automatic top-up on that`);
        }
      }
    }
  }
  if (defaults > 1) issues.push("only one plan version can be the default");

  const topUpFeatures = new Set<string>();
  for (const t of doc.topUps) {
    const tw = `top-up for ${t.feature}`;
    const f = features.get(t.feature);
    if (!f) issues.push(`${tw}: unknown feature`);
    else if (f.type === "boolean") issues.push(`${tw}: a boolean feature has no balance to top up`);
    if (topUpFeatures.has(t.feature)) issues.push(`${tw} is declared twice`);
    topUpFeatures.add(t.feature);
    if (BigInt(t.price) === 0n) issues.push(`${tw}: price must be greater than 0`);
    if (qty(t.per) <= 0n) issues.push(`${tw}: "per" must be positive`);
    if (BigInt(t.min) === 0n || BigInt(t.min) > BigInt(t.max)) issues.push(`${tw}: need 0 < min <= max`);
  }

  if (issues.length) throw new ConfigError(issues);
  return doc;
}

/**
 * The on-chain Subscription Plan for a paid plan version (decision D3): its
 * amount is the most the version can ever charge in a period, the base price
 * plus every overage cap plus the most automatic top-ups can cost. Free plans
 * need nothing on-chain.
 */
export function onchainTerms(p: PlanDoc): { amount: bigint; periodHours: number } | null {
  if (!p.price) return null;
  const caps = p.items.reduce(
    (sum, i) =>
      sum + (i.overage ? BigInt(i.overage.cap) : 0n) + (i.autoTopUp ? BigInt(i.autoTopUp.price) * BigInt(i.autoTopUp.maxPerPeriod) : 0n),
    0n,
  );
  return { amount: BigInt(p.price.amount) + caps, periodHours: p.price.periodHours };
}
