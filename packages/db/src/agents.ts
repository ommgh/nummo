/**
 * Milestone M4 in the ledger: requests paid on the spot over x402 or MPP, and
 * per-model token tracking.
 *
 * A paid request is recorded like any other money the merchant receives: an
 * invoice of kind `pay_per_use`, a payment carrying the transaction signature,
 * and a usage event, against a customer. When the caller was not identified by
 * the merchant, the customer is the paying wallet (`wallet:<address>`), so
 * agents show up in the same customer list as subscribers.
 */

import { and, eq } from "drizzle-orm";
import { type TokenKind, TOKEN_KINDS } from "@usenummo/config";
import { divCeil, formatBaseUnits, formatQty, qty, type Qty } from "@usenummo/core";
import type { Db, Scope } from "./client.ts";
import { NummoError } from "./errors.ts";
import { newId } from "./ids.ts";
import { check, type CheckResult, type TrackResult, trackInCtx } from "./operations.ts";
import { customers, customerWallets, invoiceLines, invoices, payments, usageEvents } from "./schema.ts";
import { inCustomerTx } from "./snapshot.ts";
import { emit } from "./subscriptions.ts";
import { loadEnvSettings, topUpDestination } from "./billing.ts";
import { loadCatalog } from "./catalog.ts";

// ------------------------------------------------------------------ pay per use

export type PayPerUseQuote = {
  featureId: string;
  /** Units of the feature this request uses. */
  value: string;
  /** What the request costs, in base units. */
  amount: bigint;
  /** The merchant wallet the payment goes to. */
  payTo: string;
};

/** The customer id for a wallet that paid without being identified by the merchant. */
export function walletCustomerId(wallet: string): string {
  return `wallet:${wallet}`;
}

/** What `value` units of a pay-per-use feature cost now, and where the money goes. */
export async function quotePayPerUse(db: Db, scope: Scope, featureId: string, value: string): Promise<PayPerUseQuote> {
  const { payPerUse } = await loadEnvSettings(db, scope);
  const price = payPerUse.find((p) => p.feature === featureId);
  if (!price) {
    throw new NummoError("pay_per_use_not_available", `${featureId} cannot be paid for per request; add it to payPerUse in the pricing config`);
  }
  let units: Qty;
  try {
    units = qty(value);
  } catch {
    throw new NummoError("invalid_request", "value must be a decimal string with up to 9 places");
  }
  if (units <= 0n) throw new NummoError("invalid_request", "value must be greater than 0");
  const payTo = await topUpDestination(db, scope);
  if (!payTo) throw new NummoError("pay_per_use_not_available", "no merchant wallet to pay: set payTo in the pricing config, or publish a plan");
  // Rounded up to the next base unit, like overage (doc 05, money maths).
  const amount = divCeil(units * BigInt(price.price), qty(price.per));
  return { featureId, value: formatQty(units), amount: amount > 0n ? amount : 1n, payTo };
}

export type PaidUsageInput = {
  /** The merchant's customer, when the caller was identified. Otherwise the paying wallet becomes the customer. */
  customerId?: string;
  wallet?: string;
  featureId: string;
  value: string;
  amount: bigint;
  signature: string;
  protocol: "x402" | "mpp";
  idempotencyKey?: string;
  properties?: Record<string, unknown>;
};

export type PaidUsageResult = TrackResult & {
  paid: { protocol: "x402" | "mpp"; signature: string; amount: string; wallet: string | null; invoiceId: string };
};

/**
 * Record a request that was paid on the spot: invoice, payment and usage event
 * in one customer transaction. The usage does not draw on any balance: it was
 * paid for. Recording the same signature twice returns the first result.
 */
export async function recordPaidUsage(db: Db, scope: Scope, input: PaidUsageInput): Promise<PaidUsageResult> {
  const customerId = input.customerId ?? (input.wallet ? walletCustomerId(input.wallet) : null);
  if (!customerId) throw new NummoError("invalid_request", "a paid request needs a customer id or the paying wallet");
  if (!input.customerId && input.wallet) {
    // A wallet customer starts on no plan: it pays per request, so a free plan's grant would never be used.
    await db
      .insert(customers)
      .values({ ...scope, id: customerId, name: `Agent ${input.wallet.slice(0, 4)}…${input.wallet.slice(-4)}` })
      .onConflictDoNothing();
  }
  const idempotencyKey = input.idempotencyKey ?? `pay:${input.signature}`;

  return inCustomerTx(
    db,
    scope,
    customerId,
    async (ctx) => {
      const [prevPayment] = await ctx.tx.select().from(payments).where(eq(payments.signature, input.signature));
      if (prevPayment) {
        const [ev] = await ctx.tx
          .select({ result: usageEvents.result })
          .from(usageEvents)
          .where(and(eq(usageEvents.orgId, scope.orgId), eq(usageEvents.env, scope.env), eq(usageEvents.customerId, prevPayment.customerId), eq(usageEvents.idempotencyKey, idempotencyKey)));
        if (!ev) throw new NummoError("invalid_request", "this payment was already recorded");
        return { ...(ev.result as PaidUsageResult), replayed: true };
      }
      const f = ctx.catalog.features.get(input.featureId);
      if (!f || f.type !== "metered") throw new NummoError("feature_not_found", `metered feature ${input.featureId} not found`);

      if (input.wallet) {
        await ctx.tx
          .insert(customerWallets)
          .values({ ...scope, customerId, address: input.wallet, verifiedAt: ctx.now })
          .onConflictDoNothing();
      }
      const invoiceId = newId("inv");
      await ctx.tx.insert(invoices).values({
        id: invoiceId,
        ...scope,
        customerId,
        subscriptionId: null,
        kind: "pay_per_use",
        periodStart: ctx.now,
        total: input.amount,
        amountPaid: input.amount,
        status: "paid",
        paidAt: ctx.now,
      });
      await ctx.tx
        .insert(invoiceLines)
        .values({ id: newId("il"), invoiceId, kind: "pay_per_use", featureId: input.featureId, quantity: input.value, amount: input.amount });
      await ctx.tx.insert(payments).values({
        id: newId("pay"),
        ...scope,
        customerId,
        subscriptionId: null,
        invoiceId,
        signature: input.signature,
        amount: input.amount,
        protocol: input.protocol,
        wallet: input.wallet ?? null,
        status: "confirmed",
      });

      const id = newId("evt");
      const paid = { protocol: input.protocol, signature: input.signature, amount: formatBaseUnits(input.amount), wallet: input.wallet ?? null, invoiceId };
      const result: PaidUsageResult = {
        id,
        customerId,
        featureId: input.featureId,
        value: formatQty(qty(input.value)),
        deducted: [],
        overage: null,
        unabsorbed: "0",
        replayed: false,
        paid,
      };
      await ctx.tx.insert(usageEvents).values({
        id,
        ...scope,
        customerId,
        featureId: input.featureId,
        value: result.value,
        properties: { ...(input.properties ?? {}), paid: { protocol: input.protocol, signature: input.signature } },
        idempotencyKey,
        occurredAt: ctx.now,
        result,
      });

      await emit(ctx.tx, scope, "invoice.finalized", {
        invoiceId,
        subscriptionId: null,
        customerId,
        kind: "pay_per_use",
        total: paid.amount,
        featureId: input.featureId,
        quantity: result.value,
      });
      await emit(ctx.tx, scope, "payment.succeeded", {
        invoiceId,
        subscriptionId: null,
        customerId,
        kind: "pay_per_use",
        protocol: input.protocol,
        wallet: paid.wallet,
        amount: paid.amount,
        signature: input.signature,
      });
      return result;
    },
    { create: !!input.customerId },
  );
}

// ------------------------------------------------------------------ per-model token pricing

export type TokenUsage = Partial<Record<TokenKind, string>>;

async function modelFeatures(db: Db, scope: Scope, model: string) {
  const { models } = await loadEnvSettings(db, scope);
  const m = models.find((x) => x.id === model);
  if (!m) throw new NummoError("model_not_found", `model ${model} has no price; add it to models in the pricing config`);
  return m;
}

function tokenQty(v: string | undefined, kind: string): Qty {
  if (v === undefined) return 0n;
  let q: Qty;
  try {
    q = qty(v);
  } catch {
    throw new NummoError("invalid_request", `${kind} must be a decimal string`);
  }
  if (q < 0n) throw new NummoError("invalid_request", `${kind} must not be negative`);
  return q;
}

export type TrackTokensInput = {
  customerId: string;
  model: string;
  usage: TokenUsage;
  idempotencyKey?: string;
  properties?: Record<string, unknown>;
  occurredAt?: Date;
};

/**
 * Track one model call's tokens: one usage event per kind of token, each on the
 * model's feature for that kind, in one customer transaction. The idempotency
 * key, when given, is suffixed with the kind (`<key>:input`).
 */
export async function trackTokens(db: Db, scope: Scope, input: TrackTokensInput) {
  const m = await modelFeatures(db, scope, input.model);
  const events: { kind: TokenKind; featureId: string; value: Qty }[] = [];
  for (const kind of TOKEN_KINDS) {
    const v = tokenQty(input.usage[kind], kind);
    if (input.usage[kind] !== undefined && !m.features[kind]) {
      throw new NummoError("invalid_request", `model ${input.model} has no price for ${kind} tokens`);
    }
    if (v > 0n) events.push({ kind, featureId: m.features[kind]!, value: v });
  }
  if (events.length === 0) throw new NummoError("invalid_request", "usage has no tokens");
  return inCustomerTx(db, scope, input.customerId, async (ctx) => {
    const results: (TrackResult & { kind: TokenKind })[] = [];
    for (const e of events) {
      const r = await trackInCtx(ctx, {
        featureId: e.featureId,
        value: formatQty(e.value),
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:${e.kind}` : undefined,
        properties: { ...(input.properties ?? {}), model: input.model, tokens: e.kind },
        occurredAt: input.occurredAt,
      });
      results.push({ ...r, kind: e.kind });
    }
    return { customerId: input.customerId, model: input.model, events: results };
  });
}

/**
 * May this customer make this model call? The tokens are converted to the
 * output feature's units at the model's credit rates, so one check covers
 * input and output together.
 */
export async function checkTokens(
  db: Db,
  scope: Scope,
  input: { customerId: string; model: string; usage: TokenUsage },
): Promise<CheckResult & { model: string }> {
  const m = await modelFeatures(db, scope, input.model);
  const catalogRates = await rateMap(db, scope, m);
  let credits = 0n; // in Qty units of credits, scaled
  for (const kind of TOKEN_KINDS) {
    const v = tokenQty(input.usage[kind], kind);
    if (v === 0n) continue;
    const rate = catalogRates.get(kind);
    if (rate === undefined) throw new NummoError("invalid_request", `model ${input.model} has no price for ${kind} tokens`);
    credits += v * rate; // scaled by 1e18
  }
  const outRate = catalogRates.get("output")!;
  // Output-token equivalent of the whole call, rounded up.
  const required = divCeil(credits, outRate);
  const r = await check(db, scope, { customerId: input.customerId, featureId: m.features.output, requiredBalance: formatQty(required) });
  return { ...r, model: input.model };
}

async function rateMap(db: Db, scope: Scope, m: { features: Partial<Record<TokenKind, string>> }) {
  const catalog = await loadCatalog(db, scope);
  const out = new Map<TokenKind, Qty>();
  for (const kind of TOKEN_KINDS) {
    const fid = m.features[kind];
    const r = fid ? catalog.creditRates.get(fid) : undefined;
    if (r) out.set(kind, r.rate);
  }
  if (!out.has("output")) throw new NummoError("invalid_config", "the model's output feature has no credit rate");
  return out;
}
