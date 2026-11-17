/**
 * Customers, attaching plans, manual grants, and customer reads.
 */

import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { formatBaseUnits, formatQty, isActive, periodAt, poolBalance, qty } from "@bill/core";
import type { Db, Scope } from "./client.ts";
import { findPlanVersion } from "./catalog.ts";
import { BillError } from "./errors.ts";
import { newId } from "./ids.ts";
import { customers, grants, plans, planVersions, subscriptions, usageEvents } from "./schema.ts";
import { ensureCustomer, inCustomerTx, LIVE_STATUSES, refresh } from "./snapshot.ts";

export type CustomerInput = { id: string; name?: string | null; email?: string | null };

/** PUT /v1/customers/:id. A new customer starts on the default plan. */
export async function upsertCustomer(db: Db, scope: Scope, input: CustomerInput) {
  await db.transaction(async (tx) => {
    const created = await ensureCustomer(tx, scope, input.id, input);
    if (!created && (input.name !== undefined || input.email !== undefined)) {
      await tx
        .update(customers)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
        })
        .where(and(eq(customers.orgId, scope.orgId), eq(customers.env, scope.env), eq(customers.id, input.id)));
    }
  });
  return getCustomer(db, scope, input.id);
}

/** GET /v1/customers/:id: subscriptions and balances, each with a per-grant breakdown (doc 04). */
export async function getCustomer(db: Db, scope: Scope, customerId: string) {
  return inCustomerTx(
    db,
    scope,
    customerId,
    async (ctx) => {
      const [c] = await ctx.tx
        .select()
        .from(customers)
        .where(and(eq(customers.orgId, scope.orgId), eq(customers.env, scope.env), eq(customers.id, customerId)));
      const subs = await ctx.tx
        .select({ sub: subscriptions, pv: planVersions, plan: plans })
        .from(subscriptions)
        .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
        .innerJoin(plans, and(eq(plans.orgId, planVersions.orgId), eq(plans.env, planVersions.env), eq(plans.id, planVersions.planId)))
        .where(and(eq(subscriptions.orgId, scope.orgId), eq(subscriptions.env, scope.env), eq(subscriptions.customerId, customerId)))
        .orderBy(desc(subscriptions.createdAt));

      const featureIds = [...new Set(ctx.snapshot.grants.map((g) => g.featureId))].sort();
      const balances = featureIds.map((featureId) => {
        const gs = ctx.snapshot.grants.filter((g) => g.featureId === featureId && isActive(g, ctx.now));
        const balance = poolBalance({ featureId, rate: 1n, grants: gs, overage: null }, ctx.now);
        return {
          featureId,
          balance: formatQty(balance),
          granted: formatQty(gs.reduce((s, g) => s + g.amount, 0n)),
          breakdown: gs.map((g) => ({
            grantId: g.id,
            source: g.source,
            amount: formatQty(g.amount),
            remaining: formatQty(g.remaining),
            expiresAt: g.expiresAt?.toISOString() ?? null,
            subscriptionId: g.subscriptionId ?? null,
          })),
        };
      });

      return {
        id: c!.id,
        name: c!.name,
        email: c!.email,
        createdAt: c!.createdAt.toISOString(),
        subscriptions: subs.map(({ sub, pv, plan }) => {
          const period = pv.periodHours ? periodAt(sub.periodAnchor, pv.periodHours, ctx.now) : null;
          return {
            id: sub.id,
            planId: pv.planId,
            planName: plan.name,
            version: pv.version,
            status: sub.status,
            price: pv.periodHours ? { amount: formatBaseUnits(pv.baseAmount), periodHours: pv.periodHours } : null,
            ceiling: pv.ceilingAmount !== null ? formatBaseUnits(pv.ceilingAmount) : null,
            currentPeriodStart: period?.start.toISOString() ?? null,
            currentPeriodEnd: period?.end.toISOString() ?? null,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            createdAt: sub.createdAt.toISOString(),
            endedAt: sub.endedAt?.toISOString() ?? null,
          };
        }),
        balances,
        // Invoices arrive with settlement in milestone M2.
        invoices: [] as unknown[],
      };
    },
    { create: false },
  );
}

export type AttachInput = {
  customerId: string;
  planId: string;
  version?: number;
  /**
   * Test environment only: activate a paid plan without a payment. Stands in
   * for checkout until milestone M2.
   */
  skipPayment?: boolean;
};

/** POST /v1/attach. Free plans attach at once; paid plans need checkout (milestone M2). */
export async function attach(db: Db, scope: Scope, input: AttachInput) {
  return inCustomerTx(db, scope, input.customerId, async (ctx) => {
    const pv = await findPlanVersion(ctx.tx, scope, input.planId, input.version);
    const [plan] = await ctx.tx
      .select()
      .from(plans)
      .where(and(eq(plans.orgId, scope.orgId), eq(plans.env, scope.env), eq(plans.id, pv.planId)));
    const paid = pv.ceilingAmount !== null;
    if (paid && !(input.skipPayment && scope.env === "test")) {
      throw new BillError(
        "checkout_required",
        `plan ${pv.planId} is paid; wallet checkout arrives in milestone M2. In the test environment, pass skipPayment: true.`,
      );
    }

    const live = await ctx.tx
      .select({ sub: subscriptions, pv: planVersions, plan: plans })
      .from(subscriptions)
      .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
      .innerJoin(plans, and(eq(plans.orgId, planVersions.orgId), eq(plans.env, planVersions.env), eq(plans.id, planVersions.planId)))
      .where(
        and(
          eq(subscriptions.orgId, scope.orgId),
          eq(subscriptions.env, scope.env),
          eq(subscriptions.customerId, input.customerId),
          inArray(subscriptions.status, [...LIVE_STATUSES]),
        ),
      );

    const same = live.find((l) => l.pv.id === pv.id);
    if (same) return { subscriptionId: same.sub.id, status: same.sub.status, checkoutUrl: null, alreadyAttached: true };

    // A customer has one main plan; add-ons stack. Replace the main plan, or the same add-on's older version.
    const replaced = live.filter((l) => (plan!.isAddon ? l.pv.planId === pv.planId : !l.plan.isAddon));
    for (const r of replaced) {
      await ctx.tx.update(subscriptions).set({ status: "ended", endedAt: ctx.now }).where(eq(subscriptions.id, r.sub.id));
      // End the old plan's grants now; their leftovers get expiry entries on the next reconcile.
      await ctx.tx
        .update(grants)
        .set({ expiresAt: ctx.now })
        .where(and(eq(grants.subscriptionId, r.sub.id), eq(grants.source, "plan")));
    }

    const id = newId("sub");
    await ctx.tx.insert(subscriptions).values({
      id,
      ...scope,
      customerId: input.customerId,
      planVersionId: pv.id,
      status: "active",
      periodAnchor: ctx.now,
    });
    await refresh(ctx);
    return { subscriptionId: id, status: "active" as const, checkoutUrl: null, alreadyAttached: false, replaced: replaced.map((r) => r.sub.id) };
  });
}

export type GrantInput = {
  customerId: string;
  featureId: string;
  amount: string;
  source?: "manual" | "reward" | "topup";
  expiresAt?: Date | null;
};

/** POST /v1/balances: give a customer an amount of a feature by hand. */
export async function grantBalance(db: Db, scope: Scope, input: GrantInput) {
  let amount: bigint;
  try {
    amount = qty(input.amount);
  } catch {
    throw new BillError("invalid_request", "amount must be a decimal string with up to 9 places");
  }
  if (amount <= 0n) throw new BillError("invalid_request", "amount must be positive");
  return inCustomerTx(db, scope, input.customerId, async (ctx) => {
    const f = ctx.catalog.features.get(input.featureId);
    if (!f) throw new BillError("feature_not_found", `feature ${input.featureId} not found`);
    if (f.type === "boolean") throw new BillError("invalid_request", "boolean features have no balance");
    const id = newId("grt");
    await ctx.tx.insert(grants).values({
      id,
      ...scope,
      customerId: input.customerId,
      featureId: f.id,
      source: input.source ?? "manual",
      amount: formatQty(amount),
      remaining: formatQty(amount),
      resetHours: null,
      expiresAt: input.expiresAt ?? null,
      createdAt: ctx.now,
    });
    return { grantId: id, featureId: f.id, amount: formatQty(amount), expiresAt: input.expiresAt?.toISOString() ?? null };
  });
}

/** GET /v1/events */
export async function listEvents(
  db: Db,
  scope: Scope,
  q: { customerId?: string; featureId?: string; from?: Date; to?: Date; limit?: number },
) {
  const rows = await db
    .select()
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.orgId, scope.orgId),
        eq(usageEvents.env, scope.env),
        q.customerId ? eq(usageEvents.customerId, q.customerId) : undefined,
        q.featureId ? eq(usageEvents.featureId, q.featureId) : undefined,
        q.from ? gte(usageEvents.occurredAt, q.from) : undefined,
        q.to ? lte(usageEvents.occurredAt, q.to) : undefined,
      ),
    )
    .orderBy(desc(usageEvents.occurredAt))
    .limit(Math.min(q.limit ?? 100, 1000));
  return rows.map((r) => ({
    id: r.id,
    customerId: r.customerId,
    featureId: r.featureId,
    value: formatQty(qty(r.value)),
    properties: r.properties,
    idempotencyKey: r.idempotencyKey,
    occurredAt: r.occurredAt.toISOString(),
  }));
}
