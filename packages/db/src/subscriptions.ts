/**
 * Subscription state transitions shared by attach, checkout, the settlement
 * worker and the reconciler (doc 02, "Subscription states"). Every function
 * here runs inside a customer transaction (`inCustomerTx`), so the change and
 * its webhook event commit together (doc 02, "Webhooks to the merchant").
 */

import { and, eq, inArray } from "drizzle-orm";
import type { Scope, Tx } from "./client.ts";
import { findDefaultPlanVersion } from "./catalog.ts";
import { NummoError } from "./errors.ts";
import { newId } from "./ids.ts";
import { grants, invoices, outbox, plans, planVersions, subscriptions } from "./schema.ts";
import { type CustomerCtx, LIVE_STATUSES, refresh } from "./snapshot.ts";

export type WebhookEventType =
  | "subscription.activated"
  | "subscription.renewed"
  | "subscription.past_due"
  | "subscription.canceled"
  | "subscription.resumed"
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

/**
 * End a subscription: entitlements stop now, unpaid invoices become
 * uncollectible, and a customer left without a main plan falls back to the
 * default (free) plan (doc 03, "When a pull fails").
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
  if (row.sub.status !== "pending") {
    await emit(ctx.tx, ctx.scope, "subscription.ended", subPayload(row.sub, { reason, endedAt: ctx.now.toISOString() }));
  }

  if (!row.plan.isAddon) await ensureMainPlan(ctx);
  await refresh(ctx);
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
  input: { subscriptionId: string; wallet: string; subscriptionPda: string; periodAnchor: Date },
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
    await endSubscription(ctx, r.sub.id, "replaced");
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
