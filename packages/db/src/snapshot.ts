/**
 * Loading one customer's state inside a transaction, after taking the
 * customer's row lock. Every hot-path operation starts here.
 */

import { and, eq, inArray, isNull, ne, or, gt, sql } from "drizzle-orm";
import {
  type Catalog,
  type CustomerSnapshot,
  type EntitlementItem,
  type Grant,
  accrualKey,
  currentBillingPeriod,
  formatQty,
  periodAt,
  qty,
  reconcileGrants,
} from "@usenummo/core";
import type { Scope, Tx } from "./client.ts";
import { loadCatalog, findDefaultPlanVersion } from "./catalog.ts";
import { NummoError } from "./errors.ts";
import { newId } from "./ids.ts";
import { accruals, customers, grants, ledgerEntries, locks, planItems, planVersions, subscriptions } from "./schema.ts";

export const LIVE_STATUSES = ["active", "past_due", "canceling"] as const;

/**
 * The time source for every customer transaction. Tests replace `now` to move
 * through billing periods together with a fake chain.
 */
export const clock = { now: (): Date => new Date() };

export type AccrualRow = typeof accruals.$inferSelect;

export type CustomerCtx = {
  tx: Tx;
  scope: Scope;
  customerId: string;
  now: Date;
  catalog: Catalog;
  snapshot: CustomerSnapshot;
  /** Current-period accrual rows keyed by accrualKey(subscriptionId, featureId). */
  accruals: Map<string, AccrualRow>;
  /** Automatic top-ups configured on the customer's live paid subscriptions. */
  autoTopUps: AutoTopUp[];
};

export type AutoTopUp = {
  subscriptionId: string;
  status: string;
  featureId: string;
  below: bigint;
  quantity: bigint;
  price: bigint;
  maxPerPeriod: number;
  periodStart: Date;
};

export function rowToGrant(r: typeof grants.$inferSelect): Grant {
  return {
    id: r.id,
    featureId: r.featureId,
    source: r.source,
    amount: qty(r.amount),
    remaining: qty(r.remaining),
    resetHours: r.resetHours,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    subscriptionId: r.subscriptionId,
    periodStart: r.periodStart,
  };
}

/**
 * Create the customer if they do not exist and put them on the default plan.
 * Like Autumn, check and track create unknown customers on first use.
 */
export async function ensureCustomer(
  tx: Tx,
  scope: Scope,
  customerId: string,
  fields: { name?: string | null; email?: string | null } = {},
): Promise<boolean> {
  const inserted = await tx
    .insert(customers)
    .values({ ...scope, id: customerId, name: fields.name ?? null, email: fields.email ?? null })
    .onConflictDoNothing()
    .returning({ createdAt: customers.createdAt });
  const row = inserted[0];
  if (!row) return false;
  const pv = await findDefaultPlanVersion(tx, scope);
  if (pv) {
    await tx.insert(subscriptions).values({
      id: newId("sub"),
      ...scope,
      customerId,
      planVersionId: pv.id,
      status: "active",
      periodAnchor: row.createdAt,
    });
  }
  return true;
}

async function lockCustomer(tx: Tx, scope: Scope, customerId: string) {
  const rows = await tx.execute(
    sql`select id from customers where org_id = ${scope.orgId} and env = ${scope.env} and id = ${customerId} for update`,
  );
  if (rows.rows.length === 0) throw new NummoError("customer_not_found", `customer ${customerId} not found`);
}

type LockAllocation = { grantId: string; featureId: string; amount: string };
type LockOverage = { subscriptionId: string; periodStart: string; featureId: string; units: string };

/** Give back what a lock holds: grant allocations and overage held against the cap. */
export async function releaseLock(tx: Tx, scope: Scope, lock: typeof locks.$inferSelect, status: "released" | "expired" | "confirmed", now: Date) {
  for (const a of lock.allocations as LockAllocation[]) {
    await tx
      .update(grants)
      .set({ remaining: sql`${grants.remaining} + ${a.amount}::numeric` })
      .where(eq(grants.id, a.grantId));
    await tx.insert(ledgerEntries).values({
      ...scope,
      customerId: lock.customerId,
      featureId: a.featureId,
      grantId: a.grantId,
      delta: a.amount,
      reason: "release",
      lockId: lock.lockId,
    });
  }
  const o = lock.overage as LockOverage | null;
  if (o) {
    await tx
      .update(accruals)
      .set({ heldUnits: sql`greatest(${accruals.heldUnits} - ${o.units}::numeric, 0)`, updatedAt: now })
      .where(
        and(
          eq(accruals.subscriptionId, o.subscriptionId),
          eq(accruals.periodStart, new Date(o.periodStart)),
          eq(accruals.featureId, o.featureId),
        ),
      );
  }
  await tx
    .update(locks)
    .set({ status, finalizedAt: now })
    .where(and(eq(locks.orgId, scope.orgId), eq(locks.env, scope.env), eq(locks.lockId, lock.lockId)));
}

/** Rule 8: a lock that passed its expiry without being finalised is released. */
async function releaseExpiredLocks(tx: Tx, scope: Scope, customerId: string, now: Date) {
  const expired = await tx
    .select()
    .from(locks)
    .where(
      and(
        eq(locks.orgId, scope.orgId),
        eq(locks.env, scope.env),
        eq(locks.customerId, customerId),
        eq(locks.status, "held"),
        sql`${locks.expiresAt} <= ${now}`,
      ),
    );
  for (const l of expired) await releaseLock(tx, scope, l, "expired", now);
}

export async function loadSnapshot(tx: Tx, scope: Scope, customerId: string, now: Date) {
  const subRows = await tx
    .select({ sub: subscriptions, pv: planVersions })
    .from(subscriptions)
    .innerJoin(planVersions, eq(planVersions.id, subscriptions.planVersionId))
    .where(
      and(
        eq(subscriptions.orgId, scope.orgId),
        eq(subscriptions.env, scope.env),
        eq(subscriptions.customerId, customerId),
        inArray(subscriptions.status, [...LIVE_STATUSES]),
        // A subscription replaced by an immediate plan change keeps collecting, but grants nothing.
        isNull(subscriptions.replacedBy),
      ),
    );

  const itemRows = subRows.length
    ? await tx
        .select()
        .from(planItems)
        .where(inArray(planItems.planVersionId, [...new Set(subRows.map((r) => r.pv.id))]))
    : [];

  const items: EntitlementItem[] = [];
  const autoTopUps: AutoTopUp[] = [];
  for (const { sub, pv } of subRows) {
    for (const it of itemRows.filter((i) => i.planVersionId === pv.id)) {
      if (it.autoTopUpPrice !== null && pv.periodHours !== null && sub.wallet !== null) {
        autoTopUps.push({
          subscriptionId: sub.id,
          status: sub.status,
          featureId: it.featureId,
          below: qty(it.autoTopUpBelow!),
          quantity: qty(it.autoTopUpQuantity!),
          price: it.autoTopUpPrice,
          maxPerPeriod: it.autoTopUpMaxPerPeriod!,
          periodStart: periodAt(sub.periodAnchor, pv.periodHours, now).start,
        });
      }
      const reset =
        it.resetKind === "never"
          ? ({ kind: "never" } as const)
          : { kind: "every" as const, hours: it.resetKind === "period" ? pv.periodHours! : it.resetHours! };
      items.push({
        subscriptionId: sub.id,
        featureId: it.featureId,
        included: it.included === null ? null : qty(it.included),
        reset,
        periodAnchor: sub.periodAnchor,
        billingPeriodHours: pv.periodHours ?? it.resetHours ?? 720,
        overage:
          it.overagePrice !== null && it.overagePer !== null && it.overageCap !== null
            ? { price: it.overagePrice, per: qty(it.overagePer), cap: it.overageCap }
            : null,
      });
    }
  }

  const grantRows = await tx
    .select()
    .from(grants)
    .where(
      and(
        eq(grants.orgId, scope.orgId),
        eq(grants.env, scope.env),
        eq(grants.customerId, customerId),
        or(isNull(grants.expiresAt), gt(grants.expiresAt, now), ne(grants.remaining, "0")),
      ),
    );

  const subIds = subRows.map((r) => r.sub.id);
  const accrualRows = subIds.length ? await tx.select().from(accruals).where(inArray(accruals.subscriptionId, subIds)) : [];
  const current = new Map<string, AccrualRow>();
  for (const item of items) {
    if (!item.overage) continue;
    const start = currentBillingPeriod(item, now).start.getTime();
    const row = accrualRows.find(
      (a) => a.subscriptionId === item.subscriptionId && a.featureId === item.featureId && a.periodStart.getTime() === start,
    );
    if (row) current.set(accrualKey(item.subscriptionId, item.featureId), row);
  }

  const snapshot: CustomerSnapshot = {
    grants: grantRows.map(rowToGrant),
    items,
    overageUsed: new Map([...current].map(([k, a]) => [k, qty(a.billableUnits) + qty(a.heldUnits)])),
    // Rule 6: no new overage while a payment is failing, or after a pull was cut to the on-chain ceiling.
    overageBlocked: new Set(
      subRows
        .filter((r) => r.sub.status === "past_due" || (r.sub.overageBlockedUntil !== null && r.sub.overageBlockedUntil > now))
        .map((r) => r.sub.id),
    ),
  };
  return { snapshot, accruals: current, subscriptions: subRows, autoTopUps };
}

/** Rule 9, lazily: issue this period's plan grants and zero out expired ones. */
async function reconcile(tx: Tx, scope: Scope, customerId: string, snapshot: CustomerSnapshot, now: Date): Promise<boolean> {
  const changes = reconcileGrants(snapshot.items, snapshot.grants, now, () => newId("grt"));
  for (const g of changes.expire) {
    await tx.update(grants).set({ remaining: "0" }).where(eq(grants.id, g.id));
    await tx.insert(ledgerEntries).values({
      ...scope,
      customerId,
      featureId: g.featureId,
      grantId: g.id,
      delta: formatQty(-g.remaining),
      reason: "expiry",
    });
  }
  if (changes.create.length) {
    await tx
      .insert(grants)
      .values(
        changes.create.map((g) => ({
          id: g.id,
          ...scope,
          customerId,
          featureId: g.featureId,
          source: g.source,
          amount: formatQty(g.amount),
          remaining: formatQty(g.remaining),
          resetHours: g.resetHours,
          expiresAt: g.expiresAt,
          subscriptionId: g.subscriptionId ?? null,
          periodStart: g.periodStart ?? null,
          createdAt: g.createdAt,
        })),
      )
      .onConflictDoNothing();
  }
  return changes.expire.length > 0 || changes.create.length > 0;
}

/**
 * Run `fn` inside a transaction that holds the customer's row lock (doc 02,
 * "The hot path"). Concurrent requests for one customer queue here; different
 * customers never block each other.
 */
export async function inCustomerTx<T>(
  db: { transaction: <R>(fn: (tx: Tx) => Promise<R>) => Promise<R> },
  scope: Scope,
  customerId: string,
  fn: (ctx: CustomerCtx) => Promise<T>,
  opts: { create?: boolean } = { create: true },
): Promise<T> {
  return db.transaction(async (tx) => {
    if (opts.create !== false) await ensureCustomer(tx, scope, customerId);
    await lockCustomer(tx, scope, customerId);
    const now = clock.now();
    const catalog = await loadCatalog(tx, scope);
    await releaseExpiredLocks(tx, scope, customerId, now);
    let loaded = await loadSnapshot(tx, scope, customerId, now);
    if (await reconcile(tx, scope, customerId, loaded.snapshot, now)) {
      loaded = await loadSnapshot(tx, scope, customerId, now);
    }
    const ctx: CustomerCtx = {
      tx,
      scope,
      customerId,
      now,
      catalog,
      snapshot: loaded.snapshot,
      accruals: loaded.accruals,
      autoTopUps: loaded.autoTopUps,
    };
    return fn(ctx);
  });
}

/** Reload grants and accruals after this transaction changed them. */
export async function refresh(ctx: CustomerCtx): Promise<void> {
  const loaded = await loadSnapshot(ctx.tx, ctx.scope, ctx.customerId, ctx.now);
  ctx.snapshot = loaded.snapshot;
  ctx.accruals = loaded.accruals;
  ctx.autoTopUps = loaded.autoTopUps;
}
