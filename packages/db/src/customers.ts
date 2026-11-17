/**
 * Customers, attaching plans, manual grants, and customer reads.
 */

import { and, desc, eq, gt, gte, inArray, lte } from "drizzle-orm";
import { formatBaseUnits, formatQty, isActive, periodAt, poolBalance, qty } from "@usenummo/core";
import type { Db, DbOrTx, Scope } from "./client.ts";
import { findPlanVersion } from "./catalog.ts";
import { NummoError } from "./errors.ts";
import { newId } from "./ids.ts";
import { checkoutSessions, customers, grants, invoiceLines, invoices, payments, plans, planVersions, subscriptions, usageEvents } from "./schema.ts";
import { ensureCustomer, inCustomerTx, refresh } from "./snapshot.ts";
import { endSubscription, isPaid, liveSubscriptions, replacedBy } from "./subscriptions.ts";

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
            cancelAtPeriodEnd: sub.cancelAt !== null,
            cancelAt: sub.cancelAt?.toISOString() ?? null,
            wallet: sub.wallet,
            subscriptionAddress: sub.subscriptionPda,
            pastDueSince: sub.pastDueSince?.toISOString() ?? null,
            nextRetryAt: sub.nextRetryAt?.toISOString() ?? null,
            endedReason: sub.endedReason,
            createdAt: sub.createdAt.toISOString(),
            endedAt: sub.endedAt?.toISOString() ?? null,
          };
        }),
        balances,
        invoices: await listInvoices(ctx.tx, scope, customerId, 20),
      };
    },
    { create: false },
  );
}

export type AttachInput = {
  customerId: string;
  planId: string;
  version?: number;
  /** Where the checkout sends the customer after a successful payment. */
  successUrl?: string;
  /**
   * Test environment only: activate a paid plan without a payment. Useful for
   * tests and demos without a wallet.
   */
  skipPayment?: boolean;
};

/** How long a checkout link stays usable. */
export const CHECKOUT_TTL_MS = 24 * 3_600_000;

/**
 * POST /v1/attach. Free plans attach at once. Paid plans create a pending
 * subscription and a checkout session where the customer signs once (doc 03,
 * "Activation: one signature").
 */
export async function attach(db: Db, scope: Scope, input: AttachInput, opts: { publicUrl?: string } = {}) {
  const publicUrl = (opts.publicUrl ?? process.env.NUMMO_PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, "");
  return inCustomerTx(db, scope, input.customerId, async (ctx) => {
    const pv = await findPlanVersion(ctx.tx, scope, input.planId, input.version);
    const [plan] = await ctx.tx
      .select()
      .from(plans)
      .where(and(eq(plans.orgId, scope.orgId), eq(plans.env, scope.env), eq(plans.id, pv.planId)));
    const live = await liveSubscriptions(ctx);

    const same = live.find((l) => l.pv.id === pv.id);
    if (same) return { subscriptionId: same.sub.id, status: same.sub.status, checkoutUrl: null, alreadyAttached: true };

    const replaced = replacedBy(live, pv, plan!.isAddon);
    const paid = isPaid(pv);
    const skip = paid && input.skipPayment === true && scope.env === "test";

    if (paid && !skip) {
      if (replaced.some((r) => isPaid(r.pv))) {
        throw new NummoError("not_implemented", "changing between paid plans (upgrade, downgrade) arrives in milestone M3");
      }
      if (!pv.onchainPlanPda) {
        throw new NummoError(
          "plan_not_published",
          `plan ${pv.planId} v${pv.version} has no on-chain plan yet. Run \`nummo plans publish\` with the merchant wallet.`,
        );
      }
      // Reuse an open checkout for the same plan version, so retries do not pile up pending subscriptions.
      const [open] = await ctx.tx
        .select()
        .from(checkoutSessions)
        .where(
          and(
            eq(checkoutSessions.orgId, scope.orgId),
            eq(checkoutSessions.env, scope.env),
            eq(checkoutSessions.customerId, input.customerId),
            eq(checkoutSessions.planVersionId, pv.id),
            inArray(checkoutSessions.status, ["open", "submitted"]),
            gt(checkoutSessions.expiresAt, ctx.now),
          ),
        )
        .limit(1);
      if (open) {
        return { subscriptionId: open.subscriptionId, status: "pending" as const, checkoutUrl: `${publicUrl}/checkout/${open.id}`, alreadyAttached: false };
      }

      const subscriptionId = newId("sub");
      await ctx.tx.insert(subscriptions).values({
        id: subscriptionId,
        ...scope,
        customerId: input.customerId,
        planVersionId: pv.id,
        status: "pending",
        // Replaced by the on-chain period start when the activation confirms.
        periodAnchor: ctx.now,
      });
      const sessionId = newId("cs");
      await ctx.tx.insert(checkoutSessions).values({
        id: sessionId,
        ...scope,
        customerId: input.customerId,
        planVersionId: pv.id,
        subscriptionId,
        amount: pv.baseAmount,
        successUrl: input.successUrl ?? null,
        expiresAt: new Date(ctx.now.getTime() + CHECKOUT_TTL_MS),
      });
      return { subscriptionId, status: "pending" as const, checkoutUrl: `${publicUrl}/checkout/${sessionId}`, alreadyAttached: false };
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
    for (const r of replaced) await endSubscription(ctx, r.sub.id, "replaced");
    await refresh(ctx);
    return { subscriptionId: id, status: "active" as const, checkoutUrl: null, alreadyAttached: false, replaced: replaced.map((r) => r.sub.id) };
  });
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
