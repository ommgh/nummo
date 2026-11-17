/**
 * Subscription state transitions shared by attach, checkout, the settlement
 * worker and the reconciler (doc 02, "Subscription states"). Every function
 * here runs inside a customer transaction (`inCustomerTx`), so the change and
 * its webhook event commit together (doc 02, "Webhooks to the merchant").
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Scope, Tx } from "./client.ts";
import { findDefaultPlanVersion } from "./catalog.ts";
import { NummoError } from "./errors.ts";
import { newId } from "./ids.ts";
import { checkoutSessions, grants, invoices, outbox, plans, planVersions, subscriptions } from "./schema.ts";
import { type CustomerCtx, LIVE_STATUSES, refresh } from "./snapshot.ts";

export type WebhookEventType =
  | "subscription.activated"
  | "subscription.renewed"
  | "subscription.past_due"
  | "subscription.canceled"
  | "subscription.resumed"
  | "subscription.change_scheduled"
  | "subscription.ended"
  | "payment.succeeded"
  | "payment.failed"
  | "invoice.finalized"
  | "balance.low"
  | "balance.depleted";

/** Write an event to the outbox, in the caller's transaction. */
export async function emit(tx: Tx, scope: Scope, type: WebhookEventType, payload: Record<string, unknown>) {
  await tx.insert(outbox).values({ ...scope, eventType: type, payload });
}

export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type PlanVersionRow = typeof planVersions.$inferSelect;

/** The customer's live subscriptions with their plan version and plan. */
export async function liveSubscriptions(ctx: CustomerCtx) {
  return ctx.tx
    .select({ sub: subscriptions, pv: planVersions, plan: plans })
    .from(subscriptions)
    .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
    .innerJoin(plans, and(eq(plans.orgId, planVersions.orgId), eq(plans.env, planVersions.env), eq(plans.id, planVersions.planId)))
    .where(
      and(
        eq(subscriptions.orgId, ctx.scope.orgId),
        eq(subscriptions.env, ctx.scope.env),
        eq(subscriptions.customerId, ctx.customerId),
        inArray(subscriptions.status, [...LIVE_STATUSES]),
        isNull(subscriptions.replacedBy),
      ),
    );
}

/**
 * Which live subscriptions a new one replaces: a customer has one main plan and
 * any number of add-ons, so a main plan replaces the main plan, and an add-on
 * replaces older versions of the same add-on.
 */
export function replacedBy(live: Awaited<ReturnType<typeof liveSubscriptions>>, pv: PlanVersionRow, isAddon: boolean, self?: string) {
  return live.filter((l) => l.sub.id !== self && l.pv.id !== pv.id && (isAddon ? l.pv.planId === pv.planId : !l.plan.isAddon));
}

export const isPaid = (pv: Pick<PlanVersionRow, "ceilingAmount">) => pv.ceilingAmount !== null;

function subPayload(sub: SubscriptionRow, extra: Record<string, unknown> = {}) {
  return { subscriptionId: sub.id, customerId: sub.customerId, wallet: sub.wallet, ...extra };
}

/** How long a checkout link stays usable. */
export const CHECKOUT_TTL_MS = 24 * 3_600_000;
/** A checkout created for a scheduled downgrade waits longer: the customer has to come back to sign it. */
export const SCHEDULED_CHECKOUT_TTL_MS = 7 * 24 * 3_600_000;

/** A pending subscription and the checkout session that activates it. */
export async function createSubscribeCheckout(
  ctx: CustomerCtx,
  pv: PlanVersionRow,
  opts: { successUrl?: string | null; ttlMs?: number } = {},
) {
  const subscriptionId = newId("sub");
  await ctx.tx.insert(subscriptions).values({
    id: subscriptionId,
    ...ctx.scope,
    customerId: ctx.customerId,
    planVersionId: pv.id,
    status: "pending",
    // Replaced by the on-chain period start when the activation confirms.
    periodAnchor: ctx.now,
  });
  const sessionId = newId("cs");
  await ctx.tx.insert(checkoutSessions).values({
    id: sessionId,
    ...ctx.scope,
    customerId: ctx.customerId,
    kind: "subscribe",
    planVersionId: pv.id,
    subscriptionId,
    amount: pv.baseAmount,
    successUrl: opts.successUrl ?? null,
    expiresAt: new Date(ctx.now.getTime() + (opts.ttlMs ?? CHECKOUT_TTL_MS)),
  });
  return { subscriptionId, sessionId };
}

/**
 * End a subscription: entitlements stop now, unpaid invoices become
 * uncollectible, and a customer left without a main plan falls back to the
 * default (free) plan (doc 03, "When a pull fails"). A downgrade scheduled on it
 * starts now: a free plan at once, a paid one as a checkout for the customer to sign.
 */
export async function endSubscription(ctx: CustomerCtx, subscriptionId: string, reason: string) {
  const [row] = await ctx.tx
    .select({ sub: subscriptions, plan: plans })
    .from(subscriptions)
    .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
    .innerJoin(plans, and(eq(plans.orgId, planVersions.orgId), eq(plans.env, planVersions.env), eq(plans.id, planVersions.planId)))
    .where(eq(subscriptions.id, subscriptionId));
  if (!row || row.sub.status === "ended") return;

  await ctx.tx
    .update(subscriptions)
    .set({ status: "ended", endedAt: ctx.now, endedReason: reason, nextRetryAt: null })
    .where(eq(subscriptions.id, subscriptionId));
  // The plan's grants end now; their leftovers get expiry entries on the next reconcile.
  await ctx.tx
    .update(grants)
    .set({ expiresAt: ctx.now })
    .where(and(eq(grants.subscriptionId, subscriptionId), eq(grants.source, "plan")));
  await ctx.tx
    .update(invoices)
    .set({ status: "uncollectible" })
    .where(and(eq(invoices.subscriptionId, subscriptionId), eq(invoices.status, "open")));

  // A scheduled downgrade takes over from here.
  let next: Record<string, unknown> | null = null;
  if (row.sub.scheduledPlanVersionId && row.sub.status !== "pending") {
    const [pv] = await ctx.tx.select().from(planVersions).where(eq(planVersions.id, row.sub.scheduledPlanVersionId));
    if (pv && pv.status !== "sunset") {
      if (!isPaid(pv)) {
        const id = newId("sub");
        await ctx.tx.insert(subscriptions).values({ id, ...ctx.scope, customerId: ctx.customerId, planVersionId: pv.id, status: "active", periodAnchor: ctx.now });
        next = { planId: pv.planId, version: pv.version, subscriptionId: id, status: "active" };
      } else if (pv.onchainPlanPda) {
        const c = await createSubscribeCheckout(ctx, pv, { ttlMs: SCHEDULED_CHECKOUT_TTL_MS });
        next = { planId: pv.planId, version: pv.version, subscriptionId: c.subscriptionId, status: "pending", checkoutSessionId: c.sessionId };
      }
    }
  }

  if (row.sub.status !== "pending") {
    await emit(ctx.tx, ctx.scope, "subscription.ended", subPayload(row.sub, { reason, endedAt: ctx.now.toISOString(), next }));
  }

  if (!row.plan.isAddon) await ensureMainPlan(ctx);
  await refresh(ctx);
}

/**
 * An immediate plan change replaced this subscription (doc 03, "Plan changes").
 * Its entitlements stop now. The customer signed cancelSubscription in the same
 * transaction, so the on-chain record ends with its current period; until then
 * the subscription stays `canceling`, so overage already used can be collected,
 * and it never renews.
 */
export async function windDownSubscription(ctx: CustomerCtx, subscriptionId: string, replacedBy: string, cancelAt: Date) {
  const [u] = await ctx.tx
    .update(subscriptions)
    .set({ status: "canceling", replacedBy, cancelAt, scheduledPlanVersionId: null, scheduledAt: null })
    .where(eq(subscriptions.id, subscriptionId))
    .returning();
  if (!u) return;
  await ctx.tx
    .update(grants)
    .set({ expiresAt: ctx.now })
    .where(and(eq(grants.subscriptionId, subscriptionId), eq(grants.source, "plan")));
  await emit(ctx.tx, ctx.scope, "subscription.canceled", subPayload(u, { reason: "replaced", replacedBy, endsAt: cancelAt.toISOString() }));
}

/** Put a customer with no live main plan back on the default plan, if there is one. */
async function ensureMainPlan(ctx: CustomerCtx) {
  const live = await liveSubscriptions(ctx);
  if (live.some((l) => !l.plan.isAddon)) return;
  const pv = await findDefaultPlanVersion(ctx.tx, ctx.scope);
  if (!pv) return;
  await ctx.tx.insert(subscriptions).values({
    id: newId("sub"),
    ...ctx.scope,
    customerId: ctx.customerId,
    planVersionId: pv.id,
    status: "active",
    periodAnchor: ctx.now,
  });
}

/**
 * A confirmed activation: the pending subscription becomes active with its
 * periods anchored to the on-chain record's start, and the plan it replaces ends.
 */
export async function activateSubscription(
  ctx: CustomerCtx,
  input: {
    subscriptionId: string;
    wallet: string;
    subscriptionPda: string;
    periodAnchor: Date;
    /** A plan change: the paid subscription it replaces winds down instead of ending (see windDownSubscription). */
    windDown?: { subscriptionId: string; cancelAt: Date };
  },
) {
  const [row] = await ctx.tx
    .select({ sub: subscriptions, pv: planVersions, plan: plans })
    .from(subscriptions)
    .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
    .innerJoin(plans, and(eq(plans.orgId, planVersions.orgId), eq(plans.env, planVersions.env), eq(plans.id, planVersions.planId)))
    .where(eq(subscriptions.id, input.subscriptionId));
  if (!row) throw new NummoError("internal", `subscription ${input.subscriptionId} not found`);
  if (row.sub.status !== "pending") return row.sub;

  // Activate first, so ending the replaced plan does not fall back to the default plan.
  const [sub] = await ctx.tx
    .update(subscriptions)
    .set({ status: "active", wallet: input.wallet, subscriptionPda: input.subscriptionPda, periodAnchor: input.periodAnchor })
    .where(eq(subscriptions.id, input.subscriptionId))
    .returning();
  for (const r of replacedBy(await liveSubscriptions(ctx), row.pv, row.plan.isAddon, sub!.id)) {
    if (input.windDown?.subscriptionId === r.sub.id) await windDownSubscription(ctx, r.sub.id, sub!.id, input.windDown.cancelAt);
    else await endSubscription(ctx, r.sub.id, "replaced");
  }
  await emit(
    ctx.tx,
    ctx.scope,
    "subscription.activated",
    subPayload(sub!, { planId: row.pv.planId, version: row.pv.version, periodStart: input.periodAnchor.toISOString() }),
  );
  await refresh(ctx);
  return sub!;
}

export { subPayload };
