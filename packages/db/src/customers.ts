/**
 * Customers, manual grants, and customer reads. Attaching plans is in billing.ts.
 */

import { and, desc, eq, gt, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { describePeriod, formatBaseUnits, formatQty, isActive, periodAt, poolBalance, qty } from "@usenummo/core";
import type { Db, DbOrTx, Scope } from "./client.ts";
import { NummoError } from "./errors.ts";
import { newId } from "./ids.ts";
import { checkoutSessions, customers, grants, invoiceLines, invoices, payments, plans, planVersions, subscriptions, usageEvents } from "./schema.ts";
import { ensureCustomer, inCustomerTx, LIVE_STATUSES } from "./snapshot.ts";

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
        .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id));

      const scheduledIds = subs.map((r) => r.sub.scheduledPlanVersionId).filter((x): x is string => x !== null);
      const scheduled = scheduledIds.length ? await ctx.tx.select().from(planVersions).where(inArray(planVersions.id, scheduledIds)) : [];
      const pendingCheckouts = await ctx.tx
        .select({ s: checkoutSessions, pv: planVersions })
        .from(checkoutSessions)
        .leftJoin(planVersions, eq(planVersions.id, checkoutSessions.planVersionId))
        .where(
          and(
            eq(checkoutSessions.orgId, scope.orgId),
            eq(checkoutSessions.env, scope.env),
            eq(checkoutSessions.customerId, customerId),
            inArray(checkoutSessions.status, ["open", "submitted"]),
            gt(checkoutSessions.expiresAt, ctx.now),
          ),
        )
        .orderBy(desc(checkoutSessions.createdAt));

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
            price: pv.periodHours ? { amount: formatBaseUnits(pv.baseAmount), periodHours: pv.periodHours, period: describePeriod(pv.periodHours) } : null,
            ceiling: pv.ceilingAmount !== null ? formatBaseUnits(pv.ceilingAmount) : null,
            currentPeriodStart: period?.start.toISOString() ?? null,
            currentPeriodEnd: period?.end.toISOString() ?? null,
            cancelAtPeriodEnd: sub.cancelAt !== null,
            cancelAt: sub.cancelAt?.toISOString() ?? null,
            wallet: sub.wallet,
            subscriptionAddress: sub.subscriptionPda,
            pastDueSince: sub.pastDueSince?.toISOString() ?? null,
            nextRetryAt: sub.nextRetryAt?.toISOString() ?? null,
            endedReason: sub.endedReason,
            /** Set when an immediate plan change replaced it: no entitlements, ends with its on-chain period. */
            replacedBy: sub.replacedBy,
            scheduledChange: (() => {
              const t = scheduled.find((x) => x.id === sub.scheduledPlanVersionId);
              return t && sub.scheduledAt ? { planId: t.planId, version: t.version, name: t.name, effectiveAt: sub.scheduledAt.toISOString() } : null;
            })(),
            createdAt: sub.createdAt.toISOString(),
            endedAt: sub.endedAt?.toISOString() ?? null,
          };
        }),
        /** Checkouts waiting for the customer: a new plan, an upgrade, a scheduled downgrade's new plan, or a top-up. */
        pendingCheckouts: pendingCheckouts.map(({ s, pv }) => ({
          id: s.id,
          kind: s.kind,
          status: s.status,
          planId: pv?.planId ?? null,
          version: pv?.version ?? null,
          featureId: s.featureId,
          amount: formatBaseUnits(s.amount),
          expiresAt: s.expiresAt.toISOString(),
        })),
        balances,
        invoices: await listInvoices(ctx.tx, scope, customerId, 20),
      };
    },
    { create: false },
  );
}

/** GET /v1/customers: newest first, with their live plans. */
export async function listCustomers(db: Db, scope: Scope, q: { search?: string; limit?: number; offset?: number } = {}) {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const where = and(
    eq(customers.orgId, scope.orgId),
    eq(customers.env, scope.env),
    q.search ? or(ilike(customers.id, `%${q.search}%`), ilike(customers.name, `%${q.search}%`), ilike(customers.email, `%${q.search}%`)) : undefined,
  );
  const rows = await db.select().from(customers).where(where).orderBy(desc(customers.createdAt)).limit(limit).offset(q.offset ?? 0);
  const [{ total }] = (await db.select({ total: sql<number>`count(*)::int` }).from(customers).where(where)) as [{ total: number }];
  const ids = rows.map((r) => r.id);
  const subs = ids.length
    ? await db
        .select({ customerId: subscriptions.customerId, planId: planVersions.planId, version: planVersions.version, name: planVersions.name, status: subscriptions.status, paid: sql<boolean>`${planVersions.ceilingAmount} is not null` })
        .from(subscriptions)
        .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
        .where(
          and(
            eq(subscriptions.orgId, scope.orgId),
            eq(subscriptions.env, scope.env),
            inArray(subscriptions.customerId, ids),
            inArray(subscriptions.status, [...LIVE_STATUSES]),
            sql`${subscriptions.replacedBy} is null`,
          ),
        )
    : [];
  return {
    total,
    customers: rows.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      createdAt: c.createdAt.toISOString(),
      plans: subs.filter((s) => s.customerId === c.id).map(({ customerId: _, ...s }) => s),
    })),
  };
}

/** GET /v1/customers/:id/invoices, and the `invoices` field of a customer read. */
export async function listInvoices(tx: DbOrTx, scope: Scope, customerId: string, limit = 50) {
  const rows = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.orgId, scope.orgId), eq(invoices.env, scope.env), eq(invoices.customerId, customerId)))
    .orderBy(desc(invoices.createdAt))
    .limit(limit);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [lines, pays] = await Promise.all([
    tx.select().from(invoiceLines).where(inArray(invoiceLines.invoiceId, ids)),
    tx.select().from(payments).where(inArray(payments.invoiceId, ids)),
  ]);
  return rows.map((r) => ({
    id: r.id,
    subscriptionId: r.subscriptionId,
    kind: r.kind,
    status: r.status,
    periodStart: r.periodStart.toISOString(),
    total: formatBaseUnits(r.total),
    amountPaid: formatBaseUnits(r.amountPaid),
    createdAt: r.createdAt.toISOString(),
    paidAt: r.paidAt?.toISOString() ?? null,
    lines: lines
      .filter((l) => l.invoiceId === r.id)
      .map((l) => ({
        kind: l.kind,
        featureId: l.featureId,
        quantity: l.quantity === null ? null : formatQty(qty(l.quantity)),
        amount: formatBaseUnits(l.amount),
      })),
    payments: pays
      .filter((p) => p.invoiceId === r.id)
      .map((p) => ({ signature: p.signature, amount: formatBaseUnits(p.amount), status: p.status, createdAt: p.createdAt.toISOString() })),
  }));
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
    throw new NummoError("invalid_request", "amount must be a decimal string with up to 9 places");
  }
  if (amount <= 0n) throw new NummoError("invalid_request", "amount must be positive");
  return inCustomerTx(db, scope, input.customerId, async (ctx) => {
    const f = ctx.catalog.features.get(input.featureId);
    if (!f) throw new NummoError("feature_not_found", `feature ${input.featureId} not found`);
    if (f.type === "boolean") throw new NummoError("invalid_request", "boolean features have no balance");
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
