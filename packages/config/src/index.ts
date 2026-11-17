/**
 * Pricing as config (doc 04). Merchants write `bill.config.ts` with these
 * builders; the CLI serialises it with `toDocument` and sends it to
 * `PUT /v1/config`, where the same `validateDocument` runs again.
 */

import { z } from "zod";
import { type BaseUnits, formatQty, parseHours, qty, usdc } from "@bill/core";

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

export type ConfigInput = {
  mint?: "USDC";
  features: FeatureInput[];
  plans: PlanInput[];
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

export const configDocSchema = z.object({
  mint: z.literal("USDC"),
  features: z.array(featureDocSchema),
  plans: z.array(planDocSchema),
});

export type FeatureDoc = z.infer<typeof featureDocSchema>;
export type PlanItemDoc = z.infer<typeof planItemDocSchema>;
export type PlanDoc = z.infer<typeof planDocSchema>;
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
    }
  }
  if (defaults > 1) issues.push("only one plan version can be the default");

  if (issues.length) throw new ConfigError(issues);
  return doc;
}

/**
 * The on-chain Subscription Plan for a paid plan version (decision D3): its
 * amount is the most the version can ever charge in a period, the base price
 * plus every overage cap. Free plans with no overage need nothing on-chain.
 */
export function onchainTerms(p: PlanDoc): { amount: bigint; periodHours: number } | null {
  if (!p.price) return null;
  const caps = p.items.reduce((sum, i) => sum + (i.overage ? BigInt(i.overage.cap) : 0n), 0n);
  return { amount: BigInt(p.price.amount) + caps, periodHours: p.price.periodHours };
}
