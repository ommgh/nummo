/**
 * Pricing as config (doc 04). Merchants write `nummo.config.ts` with these
 * builders; the CLI serialises it with `toDocument` and sends it to
 * `PUT /v1/config`, where the same `validateDocument` runs again.
 */

import { z } from "zod";
import { type BaseUnits, divCeil, formatQty, parseHours, qty, QTY_SCALE, usdc } from "@usenummo/core";

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

/**
 * A price per call for agents and other callers without a plan (milestone M4):
 * `price` base units buys `per` units of a metered feature, paid on the spot
 * over x402 or MPP. A request for `value` units costs value × price ÷ per,
 * rounded up to the next base unit.
 */
export type PayPerUseInput = {
  feature: string;
  price: BaseUnits;
  per?: number | string;
};

/** A model's provider price in base units per `per` tokens (default per million). */
export type ModelPriceInput = {
  input: BaseUnits;
  output: BaseUnits;
  /** Cached or cache-read input tokens, when the provider prices them separately. */
  cachedInput?: BaseUnits;
};

/**
 * Per-model token pricing (milestone M4). Each model gets one metered feature
 * per token kind (`<model>_input`, `<model>_output`, `<model>_cached_input`),
 * drawing from `creditSystem` at a rate worked out from the provider's price:
 *
 *   credits per token = price per token × (1 + markup) ÷ creditPrice
 *
 * rounded up to 9 decimal places. Track with `nummo.trackTokens`.
 */
export type ModelsInput = {
  /** The credit system the model features draw from. It must be declared in `features`. */
  creditSystem: string;
  /** What one credit is worth, in base units: usdc("0.01") makes 100 credits a dollar. */
  creditPrice: BaseUnits;
  /** Added on top of the provider's price, as a fraction (0.2) or a percentage ("20%"). Default 0. */
  markup?: number | string;
  /** The number of tokens the prices are for. Default 1,000,000. */
  per?: number;
  /** Provider prices by model name, as the model is named in `trackTokens`. */
  prices: Record<string, ModelPriceInput>;
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
  payPerUse?: PayPerUseInput[];
  models?: ModelsInput;
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

export const payPerUseDocSchema = z.object({ feature: id, price: baseUnits, per: decimal });

export const TOKEN_KINDS = ["input", "output", "cachedInput"] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

/** Which metered feature each kind of token is tracked as, for one model. */
export const modelDocSchema = z.object({
  id: z.string().min(1).max(128),
  creditSystem: id,
  features: z.object({ input: id, output: id, cachedInput: id.optional() }),
});

const solanaAddress = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "a base58 Solana address");

export const configDocSchema = z.object({
  mint: z.literal("USDC"),
  payTo: solanaAddress.nullable().default(null),
  features: z.array(featureDocSchema),
  plans: z.array(planDocSchema),
  topUps: z.array(topUpDocSchema).default([]),
  payPerUse: z.array(payPerUseDocSchema).default([]),
  models: z.array(modelDocSchema).default([]),
});

export type FeatureDoc = z.infer<typeof featureDocSchema>;
export type PlanItemDoc = z.infer<typeof planItemDocSchema>;
export type PlanDoc = z.infer<typeof planDocSchema>;
export type TopUpDoc = z.infer<typeof topUpDocSchema>;
export type PayPerUseDoc = z.infer<typeof payPerUseDocSchema>;
export type ModelDoc = z.infer<typeof modelDocSchema>;
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

  const models = input.models ? attempt("models", () => expandModels(input.models!)) : undefined;
  const doc = {
    mint: input.mint ?? "USDC",
    payPerUse: (input.payPerUse ?? []).map((p) => ({ feature: p.feature, price: p.price.toString(), per: formatQty(qty(p.per ?? 1)) })),
    models: models?.models ?? [],
    payTo: input.payTo ?? null,
    topUps: (input.topUps ?? []).map((t) => ({
      feature: t.feature,
      price: t.price.toString(),
      per: formatQty(qty(t.per ?? 1)),
      min: (t.min ?? usdc("1")).toString(),
      max: (t.max ?? usdc("1000")).toString(),
    })),
    features: [
      ...input.features.map((f) =>
        f.type === "credit_system"
          ? {
              ...f,
              rates: [
                ...f.rates.map((r) => ({ feature: r.feature, credits: formatQty(qty(r.credits)) })),
                ...(models && f.id === input.models!.creditSystem ? models.rates : []),
              ],
            }
          : f.type === "metered"
            ? { ...f, consumable: f.consumable ?? true }
            : f,
      ),
      ...(models?.features ?? []),
    ],
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

/** "claude-opus-5-5" -> "claude_opus_5_5", the stem of a model's feature ids. */
export function modelSlug(model: string): string {
  const slug = model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) throw new RangeError(`model name ${JSON.stringify(model)} has no letters or digits`);
  return /^[a-z]/.test(slug) ? slug : `m_${slug}`;
}

/** A markup as a Qty fraction: 0.2, "0.2" and "20%" are all 0.2. */
export function parseMarkup(m: number | string | undefined): bigint {
  if (m === undefined) return 0n;
  const s = String(m).trim();
  const q = s.endsWith("%") ? qty(s.slice(0, -1)) / 100n : qty(s);
  if (q < 0n) throw new RangeError("markup must not be negative");
  return q;
}

/**
 * Credits per token, as a decimal string: the provider's price per token plus
 * the markup, divided by what a credit is worth. Rounded up to 9 places, in the
 * merchant's favour.
 */
export function creditsPerToken(price: BaseUnits, opts: { creditPrice: BaseUnits; markup?: number | string; per?: number }): string {
  const per = BigInt(opts.per ?? 1_000_000);
  if (per <= 0n) throw new RangeError("per must be positive");
  if (opts.creditPrice <= 0n) throw new RangeError("creditPrice must be greater than 0");
  return formatQty(divCeil(price * (QTY_SCALE + parseMarkup(opts.markup)), per * opts.creditPrice));
}

const KIND_SUFFIX: Record<TokenKind, string> = { input: "input", output: "output", cachedInput: "cached_input" };
const KIND_LABEL: Record<TokenKind, string> = { input: "input tokens", output: "output tokens", cachedInput: "cached input tokens" };

/** The metered features, credit rates and model map that `models` in the config stands for. */
export function expandModels(m: ModelsInput) {
  const features: FeatureDoc[] = [];
  const rates: { feature: string; credits: string }[] = [];
  const models: ModelDoc[] = [];
  for (const [model, price] of Object.entries(m.prices)) {
    const slug = modelSlug(model);
    const map: Partial<Record<TokenKind, string>> = {};
    for (const kind of TOKEN_KINDS) {
      const p = price[kind];
      if (p === undefined) continue;
      const fid = `${slug}_${KIND_SUFFIX[kind]}`;
      if (fid.length > 63) throw new RangeError(`model ${model}: feature id ${fid} is longer than 63 characters`);
      if (p <= 0n) throw new RangeError(`model ${model}: ${kind} price must be greater than 0`);
      features.push({ id: fid, name: `${model} ${KIND_LABEL[kind]}`, type: "metered", consumable: true });
      rates.push({ feature: fid, credits: creditsPerToken(p, m) });
      map[kind] = fid;
    }
    models.push({ id: model, creditSystem: m.creditSystem, features: map as ModelDoc["features"] });
  }
  return { features, rates, models };
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

  const payPerUseFeatures = new Set<string>();
  for (const p of doc.payPerUse) {
    const pw = `payPerUse for ${p.feature}`;
    const f = features.get(p.feature);
    if (!f) issues.push(`${pw}: unknown feature`);
    else if (f.type !== "metered") issues.push(`${pw}: must be a metered feature (agents pay for the feature they use, not its credit system)`);
    if (payPerUseFeatures.has(p.feature)) issues.push(`${pw} is declared twice`);
    payPerUseFeatures.add(p.feature);
    if (BigInt(p.price) === 0n) issues.push(`${pw}: price must be greater than 0`);
    if (qty(p.per) <= 0n) issues.push(`${pw}: "per" must be positive`);
  }

  const modelIds = new Set<string>();
  for (const m of doc.models) {
    const mw = `model ${m.id}`;
    if (modelIds.has(m.id)) issues.push(`${mw} is declared twice`);
    modelIds.add(m.id);
    const cs = features.get(m.creditSystem);
    if (!cs || cs.type !== "credit_system") issues.push(`${mw}: ${m.creditSystem} is not a credit system`);
    for (const kind of TOKEN_KINDS) {
      const fid = m.features[kind];
      if (fid === undefined) continue;
      const f = features.get(fid);
      if (!f || f.type !== "metered") issues.push(`${mw}: ${kind} feature ${fid} must be a declared metered feature`);
      else if (creditSystemOf.get(fid) !== m.creditSystem) issues.push(`${mw}: ${fid} has no rate in credit system ${m.creditSystem}`);
    }
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
