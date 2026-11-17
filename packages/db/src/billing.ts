/**
 * Plan changes, previews and top-ups (doc 03, "Plan changes" and "One-off
 * purchases"; doc 04, "attach", "Top-ups").
 *
 * On-chain constraints shape all of this:
 * - A different plan is a different on-chain plan, so any change between paid
 *   plans needs the customer's signature.
 * - Ending a subscription at once needs the merchant's key, which the server
 *   never holds. An upgrade therefore cancels the old subscription, which runs
 *   out at its period end; we stop granting from it immediately and only
 *   collect overage already used.
 * - A new subscription's periods start when it is signed, so a downgrade cannot
 *   be signed in advance to start later. It is scheduled, and at the period end
 *   the customer is asked to sign the new plan (or moves to it at once if free).
 */

import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import {
  describePeriod,
  formatBaseUnits,
  formatQty,
  periodAt,
  type Proration,
  prorate,
  qty,
  topUpQuantity,
} from "@usenummo/core";
import type { ModelDoc, PayPerUseDoc, TopUpDoc } from "@usenummo/config";
import type { Db, Scope } from "./client.ts";
import { findPlanVersion } from "./catalog.ts";
import { NummoError } from "./errors.ts";
import { newId } from "./ids.ts";
import {
  checkoutSessions,
  envSettings,
  grants,
  invoiceLines,
  invoices,
  plans,
  planVersions,
  settlementAttempts,
  subscriptions,
} from "./schema.ts";
import { type CustomerCtx, inCustomerTx, refresh } from "./snapshot.ts";
import {
  CHECKOUT_TTL_MS,
  createSubscribeCheckout,
  emit,
  endSubscription,
  isPaid,
  liveSubscriptions,
  type PlanVersionRow,
  replacedBy,
  subPayload,
} from "./subscriptions.ts";

type LiveRow = Awaited<ReturnType<typeof liveSubscriptions>>[number];

export type PlanChangeQuote = Proration & { periodStart: Date; periodEnd: Date };

/**
 * What changing `old` to `pv` costs now (see `prorate` in the core). Throws
 * `plan_change_blocked` when the change cannot be priced safely: a failed
 * payment, or the current period's base fee not collected yet.
 */
export async function quotePlanChange(ctx: CustomerCtx, old: LiveRow, pv: PlanVersionRow): Promise<PlanChangeQuote> {
  const s = old.sub;
  if (s.status === "past_due") {
    throw new NummoError("plan_change_blocked", "A payment on the current plan failed. Settle it before changing plans.");
  }
  const period = periodAt(s.periodAnchor, old.pv.periodHours!, ctx.now);
  const [inflight] = await ctx.tx
    .select({ id: settlementAttempts.id })
    .from(settlementAttempts)
    .where(and(eq(settlementAttempts.subscriptionId, s.id), eq(settlementAttempts.status, "pending")))
    .limit(1);
  if (inflight) throw new NummoError("plan_change_blocked", "A payment on the current plan is being confirmed. Try again in a minute.");

  const [base] = await ctx.tx
    .select({ status: invoices.status })
    .from(invoices)
    .where(and(eq(invoices.subscriptionId, s.id), eq(invoices.periodStart, period.start), inArray(invoices.kind, ["activation", "renewal"])));
  const periodPaid = base?.status === "paid";
  if (!periodPaid && old.pv.baseAmount > 0n) {
    throw new NummoError("plan_change_blocked", "This period's payment on the current plan has not been collected yet. Try again in a few minutes.");
  }
  const p = prorate({
    from: { base: old.pv.baseAmount, periodHours: old.pv.periodHours! },
    to: { base: pv.baseAmount, periodHours: pv.periodHours! },
    periodStart: period.start,
    periodEnd: period.end,
    periodPaid,
    now: ctx.now,
  });
  return { ...p, periodStart: period.start, periodEnd: period.end };
}

/** The live main plan, or the add-on version, that attaching `pv` would replace, and whether it is paid. */
async function changeContext(ctx: CustomerCtx, pv: PlanVersionRow) {
  const [plan] = await ctx.tx
    .select()
    .from(plans)
    .where(and(eq(plans.orgId, ctx.scope.orgId), eq(plans.env, ctx.scope.env), eq(plans.id, pv.planId)));
  const live = await liveSubscriptions(ctx);
  const same = live.find((l) => l.pv.id === pv.id) ?? null;
  const replaced = replacedBy(live, pv, plan!.isAddon);
  return { plan: plan!, live, same, replaced, paidOld: replaced.find((r) => isPaid(r.pv)) ?? null };
}

export type AttachInput = {
  customerId: string;
  planId: string;
  version?: number;
  /** Where the checkout sends the customer after a successful payment. */
  successUrl?: string;
  /** Test environment only: activate a paid plan without a payment, for tests and demos. */
  skipPayment?: boolean;
};

export type AttachResult = {
  subscriptionId: string | null;
  status: "active" | "pending" | "scheduled" | "past_due" | "canceling";
  checkoutUrl: string | null;
  alreadyAttached: boolean;
  /** For an upgrade: the credit for the unused part of the current period, and what is due now. */
  proration?: { credit: string; dueNow: string };
  /** For a scheduled downgrade: when it takes effect. */
  effectiveAt?: string;
  replaced?: string[];
};

const publicBase = (publicUrl?: string) => (publicUrl ?? process.env.NUMMO_PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, "");

/**
 * POST /v1/attach (doc 04).
 *
 * - Free plan, nothing paid to replace: attached at once.
 * - Paid plan, nothing paid to replace: a pending subscription and a checkout.
 * - Paid to paid, upgrade: a checkout where the current wallet signs the new
 *   subscription, the prorated first charge and the old plan's cancellation.
 * - Paid to cheaper, or paid to free: scheduled for the end of the period.
 * - The current plan again: cancels a scheduled downgrade.
 */
export async function attach(db: Db, scope: Scope, input: AttachInput, opts: { publicUrl?: string } = {}): Promise<AttachResult> {
  const base = publicBase(opts.publicUrl);
  return inCustomerTx(db, scope, input.customerId, async (ctx) => {
    const pv = await findPlanVersion(ctx.tx, scope, input.planId, input.version);
    const { replaced, same, paidOld } = await changeContext(ctx, pv);

    if (same) {
      // Attaching the current plan again keeps it: cancel a downgrade scheduled on it.
      if (same.sub.scheduledPlanVersionId) {
        await ctx.tx.update(subscriptions).set({ scheduledPlanVersionId: null, scheduledAt: null }).where(eq(subscriptions.id, same.sub.id));
        await emit(ctx.tx, scope, "subscription.change_scheduled", subPayload(same.sub, { planId: null, effectiveAt: null, canceled: true }));
      }
      return { subscriptionId: same.sub.id, status: same.sub.status as AttachResult["status"], checkoutUrl: null, alreadyAttached: true };
    }

    const paid = isPaid(pv);
    const skip = paid && input.skipPayment === true && scope.env === "test";
    if (paid && !skip && !pv.onchainPlanPda) {
      throw new NummoError(
        "plan_not_published",
        `plan ${pv.planId} v${pv.version} has no on-chain plan yet. Run \`nummo plans publish\` with the merchant wallet.`,
      );
    }

    // Leaving a paid plan.
    if (paidOld && !skip) {
      if (paidOld.sub.status === "canceling" && paidOld.sub.cancelAt && !paid) {
        // Already cancelled on-chain: it ends at its period end, then this plan starts.
        return schedule(ctx, paidOld, pv, paidOld.sub.cancelAt);
      }
      const quote = paid ? await quotePlanChange(ctx, paidOld, pv) : null;
      if (!quote || quote.direction === "downgrade") {
        const at = quote?.effectiveAt ?? periodAt(paidOld.sub.periodAnchor, paidOld.pv.periodHours!, ctx.now).end;
        return schedule(ctx, paidOld, pv, at);
      }
      if (!paidOld.sub.wallet) throw new NummoError("plan_change_blocked", "the current plan has no wallet on record");
      const open = await openCheckout(ctx, pv.id, "change");
      if (open) return pendingResult(base, open, quote);
      const subscriptionId = newId("sub");
      await ctx.tx.insert(subscriptions).values({
        id: subscriptionId,
        ...scope,
        customerId: input.customerId,
        planVersionId: pv.id,
        status: "pending",
        periodAnchor: ctx.now,
      });
      const [session] = await ctx.tx
        .insert(checkoutSessions)
        .values({
          id: newId("cs"),
          ...scope,
          customerId: input.customerId,
          kind: "change",
          planVersionId: pv.id,
          subscriptionId,
          replacesSubscriptionId: paidOld.sub.id,
          // The wallet paying for the current plan must sign: it cancels that subscription.
          wallet: paidOld.sub.wallet,
          amount: quote.dueNow,
          proration: quoteJson(quote),
          successUrl: input.successUrl ?? null,
          expiresAt: new Date(ctx.now.getTime() + CHECKOUT_TTL_MS),
        })
        .returning();
      return pendingResult(base, session!, quote);
    }

    if (paid && !skip) {
      const open = await openCheckout(ctx, pv.id, "subscribe");
      if (open) return pendingResult(base, open, null);
      const { subscriptionId, sessionId } = await createSubscribeCheckout(ctx, pv, { successUrl: input.successUrl });
      return { subscriptionId, status: "pending", checkoutUrl: `${base}/checkout/${sessionId}`, alreadyAttached: false };
    }

    const id = newId("sub");
    await ctx.tx.insert(subscriptions).values({ id, ...scope, customerId: input.customerId, planVersionId: pv.id, status: "active", periodAnchor: ctx.now });
    for (const r of replaced) await endSubscription(ctx, r.sub.id, "replaced");
    await refresh(ctx);
    return { subscriptionId: id, status: "active", checkoutUrl: null, alreadyAttached: false, replaced: replaced.map((r) => r.sub.id) };
  });
}

const quoteJson = (q: PlanChangeQuote) => ({
  credit: q.credit.toString(),
  dueNow: q.dueNow.toString(),
  periodStart: q.periodStart.toISOString(),
  periodEnd: q.periodEnd.toISOString(),
});

function pendingResult(base: string, s: typeof checkoutSessions.$inferSelect, quote: PlanChangeQuote | null): AttachResult {
  return {
    subscriptionId: s.subscriptionId,
    status: "pending",
    checkoutUrl: `${base}/checkout/${s.id}`,
    alreadyAttached: false,
    ...(quote ? { proration: { credit: formatBaseUnits(quote.credit), dueNow: formatBaseUnits(quote.dueNow) } } : {}),
  };
}

/** Reuse an open checkout for the same plan version, so retries do not pile up pending subscriptions. */
async function openCheckout(ctx: CustomerCtx, planVersionId: string, kind: "subscribe" | "change") {
  const [open] = await ctx.tx
    .select()
    .from(checkoutSessions)
    .where(
      and(
        eq(checkoutSessions.orgId, ctx.scope.orgId),
        eq(checkoutSessions.env, ctx.scope.env),
        eq(checkoutSessions.customerId, ctx.customerId),
        eq(checkoutSessions.planVersionId, planVersionId),
        eq(checkoutSessions.kind, kind),
        inArray(checkoutSessions.status, ["open", "submitted"]),
        gt(checkoutSessions.expiresAt, ctx.now),
      ),
    )
    .limit(1);
  return open ?? null;
}

async function schedule(ctx: CustomerCtx, old: LiveRow, pv: PlanVersionRow, at: Date): Promise<AttachResult> {
  const [u] = await ctx.tx
    .update(subscriptions)
    .set({ scheduledPlanVersionId: pv.id, scheduledAt: at })
    .where(eq(subscriptions.id, old.sub.id))
    .returning();
  await emit(ctx.tx, ctx.scope, "subscription.change_scheduled", subPayload(u!, { planId: pv.planId, version: pv.version, effectiveAt: at.toISOString() }));
  return { subscriptionId: old.sub.id, status: "scheduled", checkoutUrl: null, alreadyAttached: false, effectiveAt: at.toISOString() };
}

/** POST /v1/preview: what attaching a plan would do and cost, without changing anything. */
export async function preview(db: Db, scope: Scope, input: { customerId: string; planId: string; version?: number }) {
  return inCustomerTx(db, scope, input.customerId, async (ctx) => {
    const pv = await findPlanVersion(ctx.tx, scope, input.planId, input.version);
    const { same, paidOld, replaced } = await changeContext(ctx, pv);
    const target = {
      planId: pv.planId,
      version: pv.version,
      name: pv.name,
      price: pv.periodHours ? { amount: formatBaseUnits(pv.baseAmount), periodHours: pv.periodHours, period: describePeriod(pv.periodHours) } : null,
      ceiling: pv.ceilingAmount !== null ? formatBaseUnits(pv.ceilingAmount) : null,
    };
    const from = replaced[0] ? { planId: replaced[0].pv.planId, version: replaced[0].pv.version, subscriptionId: replaced[0].sub.id } : null;
    if (same) return { change: "none" as const, plan: target, from: null, dueNow: "0", credit: "0", effectiveAt: ctx.now.toISOString(), signatureRequired: false };
    if (paidOld && isPaid(pv)) {
      let q: PlanChangeQuote;
      try {
        q = await quotePlanChange(ctx, paidOld, pv);
      } catch (e) {
        if (e instanceof NummoError) return { change: "blocked" as const, plan: target, from, reason: e.message, dueNow: "0", credit: "0", effectiveAt: null, signatureRequired: false };
        throw e;
      }
      return {
        change: q.direction,
        plan: target,
        from,
        dueNow: formatBaseUnits(q.dueNow),
        credit: formatBaseUnits(q.credit),
        effectiveAt: q.effectiveAt.toISOString(),
        // A downgrade to a paid plan is signed at the period end.
        signatureRequired: true,
      };
    }
    if (paidOld) {
      const at = paidOld.sub.cancelAt ?? periodAt(paidOld.sub.periodAnchor, paidOld.pv.periodHours!, ctx.now).end;
      return { change: "downgrade" as const, plan: target, from, dueNow: "0", credit: "0", effectiveAt: at.toISOString(), signatureRequired: false };
    }
    return {
      change: "new" as const,
      plan: target,
      from,
      dueNow: formatBaseUnits(pv.baseAmount),
      credit: "0",
      effectiveAt: ctx.now.toISOString(),
      signatureRequired: isPaid(pv),
    };
  });
}

// ------------------------------------------------------------------ one-off top-ups

export async function loadEnvSettings(db: Db, scope: Scope) {
  const [row] = await db.select().from(envSettings).where(and(eq(envSettings.orgId, scope.orgId), eq(envSettings.env, scope.env)));
  return {
    payTo: row?.payTo ?? null,
    topUps: (row?.topUps ?? []) as TopUpDoc[],
    payPerUse: (row?.payPerUse ?? []) as PayPerUseDoc[],
    models: (row?.models ?? []) as ModelDoc[],
  };
}

/** The wallet one-off payments go to: `payTo` from the config, else the owner of the latest published plan. */
export async function topUpDestination(db: Db, scope: Scope): Promise<string | null> {
  const { payTo } = await loadEnvSettings(db, scope);
  if (payTo) return payTo;
  const [pv] = await db
    .select({ owner: planVersions.onchainOwner })
    .from(planVersions)
    .where(and(eq(planVersions.orgId, scope.orgId), eq(planVersions.env, scope.env), isNotNull(planVersions.onchainOwner)))
    .orderBy(desc(planVersions.publishedAt))
    .limit(1);
  return pv?.owner ?? null;
}

export type TopUpInput = { customerId: string; featureId: string; amount: bigint; successUrl?: string };

/** POST /v1/topups: a checkout where the customer buys `amount` worth of a feature's balance with one transfer. */
export async function createTopUp(db: Db, scope: Scope, input: TopUpInput, opts: { publicUrl?: string; reference: () => string }) {
  const { topUps } = await loadEnvSettings(db, scope);
  const price = topUps.find((t) => t.feature === input.featureId);
  if (!price) throw new NummoError("topup_not_available", `${input.featureId} cannot be topped up; add it to topUps in the pricing config`);
  const min = BigInt(price.min);
  const max = BigInt(price.max);
  if (input.amount < min || input.amount > max) {
    throw new NummoError("invalid_request", `a top-up of ${input.featureId} is between ${formatBaseUnits(min)} and ${formatBaseUnits(max)} USDC`);
  }
  const payTo = await topUpDestination(db, scope);
  if (!payTo) throw new NummoError("topup_not_available", "no merchant wallet to pay: set payTo in the pricing config, or publish a plan");
  const quantity = topUpQuantity(input.amount, { price: BigInt(price.price), per: qty(price.per) });
  const base = publicBase(opts.publicUrl);
  return inCustomerTx(db, scope, input.customerId, async (ctx) => {
    const id = newId("cs");
    await ctx.tx.insert(checkoutSessions).values({
      id,
      ...scope,
      customerId: input.customerId,
      kind: "topup",
      featureId: input.featureId,
      quantity: formatQty(quantity),
      payTo,
      reference: opts.reference(),
      amount: input.amount,
      successUrl: input.successUrl ?? null,
      expiresAt: new Date(ctx.now.getTime() + CHECKOUT_TTL_MS),
    });
    return {
      checkoutUrl: `${base}/checkout/${id}`,
      featureId: input.featureId,
      quantity: formatQty(quantity),
      amount: formatBaseUnits(input.amount),
    };
  });
}

/** Grant a purchased balance. It never expires and is used after plan grants (rule 3). */
export async function grantTopUp(ctx: CustomerCtx, featureId: string, quantity: string) {
  const id = newId("grt");
  await ctx.tx.insert(grants).values({
    id,
    ...ctx.scope,
    customerId: ctx.customerId,
    featureId,
    source: "topup",
    amount: quantity,
    remaining: quantity,
    resetHours: null,
    expiresAt: null,
    createdAt: ctx.now,
  });
  return id;
}

// ------------------------------------------------------------------ automatic top-ups

/**
 * After usage, refill any balance with an automatic top-up that fell below its
 * threshold: write an open `topup` invoice on the subscription, which the
 * settlement worker pulls like any other. The credits are granted once the
 * pull confirms. At most one open refill per subscription and feature, and at
 * most `maxPerPeriod` per billing period, which the on-chain ceiling includes.
 */
export async function maybeAutoTopUp(ctx: CustomerCtx) {
  for (const a of ctx.autoTopUps) {
    if (a.status !== "active" && a.status !== "canceling") continue;
    const [bal] = await ctx.tx
      .select({ v: sql<string>`coalesce(sum(${grants.remaining}), 0)::text` })
      .from(grants)
      .where(
        and(
          eq(grants.orgId, ctx.scope.orgId),
          eq(grants.env, ctx.scope.env),
          eq(grants.customerId, ctx.customerId),
          eq(grants.featureId, a.featureId),
          sql`(${grants.expiresAt} is null or ${grants.expiresAt} > ${ctx.now})`,
        ),
      );
    if (qty(bal!.v) >= a.below) continue;
    const refills = await ctx.tx
      .select({ status: invoices.status })
      .from(invoices)
      .innerJoin(invoiceLines, eq(invoiceLines.invoiceId, invoices.id))
      .where(
        and(
          eq(invoices.subscriptionId, a.subscriptionId),
          eq(invoices.kind, "topup"),
          eq(invoiceLines.featureId, a.featureId),
          inArray(invoices.status, ["open", "paid"]),
          sql`(${invoices.status} = 'open' or ${invoices.periodStart} = ${a.periodStart})`,
        ),
      );
    if (refills.some((r) => r.status === "open")) continue;
    if (refills.length >= a.maxPerPeriod) continue;
    const invoiceId = newId("inv");
    await ctx.tx.insert(invoices).values({
      id: invoiceId,
      ...ctx.scope,
      customerId: ctx.customerId,
      subscriptionId: a.subscriptionId,
      kind: "topup",
      periodStart: a.periodStart,
      total: a.price,
    });
    await ctx.tx.insert(invoiceLines).values({ id: newId("il"), invoiceId, kind: "topup", featureId: a.featureId, quantity: formatQty(a.quantity), amount: a.price });
    await emit(ctx.tx, ctx.scope, "invoice.finalized", {
      invoiceId,
      subscriptionId: a.subscriptionId,
      customerId: ctx.customerId,
      kind: "topup",
      periodStart: a.periodStart.toISOString(),
      total: formatBaseUnits(a.price),
      automatic: true,
    });
  }
}
