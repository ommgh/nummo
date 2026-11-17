/**
 * check, track, locks and finalize: the hot path from doc 02.
 * All amounts in inputs and outputs are decimal strings at this boundary.
 */

import { and, eq, sql } from "drizzle-orm";
import {
  type DeductionResult,
  type Pool,
  type Qty,
  accrualKey,
  available,
  canCover,
  formatBaseUnits,
  formatQty,
  hasBooleanFeature,
  isActive,
  overageCost,
  overageHeadroom,
  planDeduction,
  poolBalance,
  poolsFor,
  qty,
  sumQty,
} from "@bill/core";
import type { Db, Scope } from "./client.ts";
import { BillError } from "./errors.ts";
import { newId } from "./ids.ts";
import { accruals, grants, ledgerEntries, locks, outbox, usageEvents } from "./schema.ts";
import { type CustomerCtx, inCustomerTx, refresh, releaseLock } from "./snapshot.ts";

// ------------------------------------------------------------------ types

export type CheckInput = {
  customerId: string;
  featureId: string;
  /** Defaults to 1 for metered features. Ignored for boolean features. */
  requiredBalance?: string;
  /** Reserve the balance now; confirm or release it with finalize (rule 8). */
  lock?: { lockId: string; expiresAt: Date };
  /** Check and, if allowed, track `requiredBalance` in one call. */
  sendEvent?: boolean;
  idempotencyKey?: string;
  properties?: Record<string, unknown>;
};

export type BalanceView = { featureId: string; balance: string; rate: string };

export type CheckResult = {
  allowed: boolean;
  customerId: string;
  featureId: string;
  type: "boolean" | "metered" | "credit_system";
  requiredBalance: string | null;
  /** What the customer can still use of this feature, in its own units, including overage headroom. */
  available: string | null;
  /** The balances this feature draws from, direct first then credits. */
  balances: BalanceView[];
  overage: { allowed: boolean; headroom: string } | null;
  nextResetAt: string | null;
  lock?: { lockId: string; expiresAt: string };
  event?: TrackResult;
};

export type TrackInput = {
  customerId: string;
  featureId: string;
  value: string;
  idempotencyKey?: string;
  properties?: Record<string, unknown>;
  occurredAt?: Date;
};

export type TrackResult = {
  id: string;
  customerId: string;
  featureId: string;
  value: string;
  deducted: { featureId: string; amount: string }[];
  overage: { featureId: string; units: string; amount: string } | null;
  /** Usage that no balance or overage covered. Recorded, but not billed. */
  unabsorbed: string;
  replayed: boolean;
};

export type FinalizeInput = {
  lockId: string;
  action: "confirm" | "release";
  /** Real amount used. Defaults to the amount held. */
  overrideValue?: string;
  properties?: Record<string, unknown>;
};

// ------------------------------------------------------------------ helpers

function parsePositive(value: string | undefined, field: string, fallback: Qty): Qty {
  if (value === undefined) return fallback;
  let q: Qty;
  try {
    q = qty(value);
  } catch {
    throw new BillError("invalid_request", `${field} must be a decimal string with up to 9 places`);
  }
  if (q < 0n) throw new BillError("invalid_request", `${field} must not be negative`);
  return q;
}

function featureOf(ctx: CustomerCtx, featureId: string) {
  const f = ctx.catalog.features.get(featureId);
  if (!f) throw new BillError("feature_not_found", `feature ${featureId} not found`);
  return f;
}

function balancesOf(pools: Pool[], now: Date): BalanceView[] {
  return pools.map((p) => ({ featureId: p.featureId, balance: formatQty(poolBalance(p, now)), rate: formatQty(p.rate) }));
}

function nextResetAt(pools: Pool[], now: Date): string | null {
  const ends = pools
    .flatMap((p) => p.grants)
    .filter((g) => g.resetHours !== null && g.expiresAt && isActive(g, now))
    .map((g) => g.expiresAt!.getTime());
  return ends.length ? new Date(Math.min(...ends)).toISOString() : null;
}

function overageView(pools: Pool[]) {
  const p = [...pools].reverse().find((x) => x.overage !== null);
  if (!p) return null;
  const headroom = overageHeadroom(p);
  return { allowed: headroom > 0n, headroom: formatQty(headroom) };
}

/** Write grant deductions and their ledger entries. */
async function applyDeduction(
  ctx: CustomerCtx,
  r: DeductionResult,
  reason: "usage" | "lock",
  refs: { usageEventId?: string; lockId?: string },
) {
  for (const a of r.allocations) {
    const amount = formatQty(a.amount);
    const updated = await ctx.tx
      .update(grants)
      .set({ remaining: sql`${grants.remaining} - ${amount}::numeric` })
      .where(and(eq(grants.id, a.grantId), sql`${grants.remaining} >= ${amount}::numeric`))
      .returning({ id: grants.id });
    if (updated.length !== 1) throw new BillError("internal", `grant ${a.grantId} changed under the customer lock`);
    await ctx.tx.insert(ledgerEntries).values({
      ...ctx.scope,
      customerId: ctx.customerId,
      featureId: a.featureId,
      grantId: a.grantId,
      delta: formatQty(-a.amount),
      reason,
      usageEventId: refs.usageEventId ?? null,
      lockId: refs.lockId ?? null,
    });
  }
}

/** Add overage to the period's accrual row, billed or held by a lock. */
async function accrue(ctx: CustomerCtx, pools: Pool[], o: NonNullable<DeductionResult["overage"]>, kind: "billable" | "held") {
  const pool = pools.find((p) => p.featureId === o.featureId)!;
  const key = accrualKey(o.subscriptionId, o.featureId);
  const prev = ctx.accruals.get(key);
  const prevBillable = qty(prev?.billableUnits ?? "0");
  const billable = prevBillable + (kind === "billable" ? o.units : 0n);
  const held = qty(prev?.heldUnits ?? "0") + (kind === "held" ? o.units : 0n);
  const amount = overageCost(billable, pool.overage!.price);
  const [row] = await ctx.tx
    .insert(accruals)
    .values({
      id: newId("acr"),
      ...ctx.scope,
      subscriptionId: o.subscriptionId,
      periodStart: o.periodStart,
      featureId: o.featureId,
      billableUnits: formatQty(billable),
      heldUnits: formatQty(held),
      amount,
    })
    .onConflictDoUpdate({
      target: [accruals.subscriptionId, accruals.periodStart, accruals.featureId],
      set: { billableUnits: formatQty(billable), heldUnits: formatQty(held), amount, updatedAt: ctx.now },
    })
    .returning();
  ctx.accruals.set(key, row!);
  // This event's share: the change in the period total, so per-event amounts add up to the invoice line.
  return amount - overageCost(prevBillable, pool.overage!.price);
}

/** Emit balance.low / balance.depleted when a pool crosses a threshold (doc 02, hot path step 5). */
async function emitThresholds(ctx: CustomerCtx, before: Pool[], after: Pool[]) {
  for (const b of before) {
    const a = after.find((p) => p.featureId === b.featureId);
    if (!a) continue;
    const was = poolBalance(b, ctx.now);
    const now = poolBalance(a, ctx.now);
    // "Low" means 10% or less of what is currently granted.
    const granted = sumQty(a.grants.filter((g) => isActive(g, ctx.now)).map((g) => g.amount));
    const low = granted / 10n;
    let type: string | null = null;
    if (was > 0n && now === 0n) type = "balance.depleted";
    else if (was > low && now <= low && now > 0n) type = "balance.low";
    if (type) {
      await ctx.tx.insert(outbox).values({
        ...ctx.scope,
        eventType: type,
        payload: { customerId: ctx.customerId, featureId: b.featureId, balance: formatQty(now), at: ctx.now.toISOString() },
      });
    }
  }
}

function view(ctx: CustomerCtx, featureId: string) {
  return poolsFor(ctx.catalog, ctx.snapshot, featureId, ctx.now);
}

// ------------------------------------------------------------------ track

async function trackInCtx(ctx: CustomerCtx, input: Omit<TrackInput, "customerId">): Promise<TrackResult> {
  const value = parsePositive(input.value, "value", 0n);

  // Rule 7: a repeated idempotency key returns the first result and changes nothing.
  if (input.idempotencyKey) {
    const [prev] = await ctx.tx
      .select({ result: usageEvents.result })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.orgId, ctx.scope.orgId),
          eq(usageEvents.env, ctx.scope.env),
          eq(usageEvents.customerId, ctx.customerId),
          eq(usageEvents.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (prev) return { ...(prev.result as TrackResult), replayed: true };
  }

  const f = featureOf(ctx, input.featureId);
  if (f.type === "boolean") throw new BillError("invalid_request", `feature ${f.id} is boolean; there is nothing to track`);
  if (f.type === "credit_system") {
    throw new BillError("invalid_request", `track the underlying feature, not the credit system ${f.id} (rule 4)`);
  }

  const before = view(ctx, f.id);
  const r = planDeduction(before, value, ctx.now);
  const id = newId("evt");
  await applyDeduction(ctx, r, "usage", { usageEventId: id });
  let overageAmount = 0n;
  if (r.overage) overageAmount = await accrue(ctx, before, r.overage, "billable");

  const deducted = new Map<string, Qty>();
  for (const a of r.allocations) deducted.set(a.featureId, (deducted.get(a.featureId) ?? 0n) + a.amount);
  const result: TrackResult = {
    id,
    customerId: ctx.customerId,
    featureId: f.id,
    value: formatQty(value),
    deducted: [...deducted].map(([featureId, amount]) => ({ featureId, amount: formatQty(amount) })),
    overage: r.overage
      ? { featureId: r.overage.featureId, units: formatQty(r.overage.units), amount: formatBaseUnits(overageAmount) }
      : null,
    unabsorbed: formatQty(r.unabsorbed),
    replayed: false,
  };

  await ctx.tx.insert(usageEvents).values({
    id,
    ...ctx.scope,
    customerId: ctx.customerId,
    featureId: f.id,
    value: formatQty(value),
    properties: input.properties ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    occurredAt: input.occurredAt ?? ctx.now,
    result,
  });

  await refresh(ctx);
  await emitThresholds(ctx, before, view(ctx, f.id));
  return result;
}

export function track(db: Db, scope: Scope, input: TrackInput): Promise<TrackResult> {
  return inCustomerTx(db, scope, input.customerId, (ctx) => trackInCtx(ctx, input));
}

/** Up to 1,000 events. Each customer's events run in one transaction, in order. */
export async function trackBatch(db: Db, scope: Scope, events: TrackInput[]): Promise<TrackResult[]> {
  if (events.length > 1000) throw new BillError("invalid_request", "a batch holds at most 1,000 events");
  const results: TrackResult[] = new Array(events.length);
  const byCustomer = new Map<string, number[]>();
  events.forEach((e, i) => byCustomer.set(e.customerId, [...(byCustomer.get(e.customerId) ?? []), i]));
  for (const [customerId, idx] of byCustomer) {
    await inCustomerTx(db, scope, customerId, async (ctx) => {
      for (const i of idx) results[i] = await trackInCtx(ctx, events[i]!);
    });
  }
  return results;
}

// ------------------------------------------------------------------ check

export function check(db: Db, scope: Scope, input: CheckInput): Promise<CheckResult> {
  if (input.lock && input.sendEvent) throw new BillError("invalid_request", "use either lock or sendEvent, not both");
  return inCustomerTx(db, scope, input.customerId, async (ctx) => {
    const f = featureOf(ctx, input.featureId);

    if (f.type === "boolean") {
      return {
        allowed: hasBooleanFeature(ctx.snapshot, f.id),
        customerId: ctx.customerId,
        featureId: f.id,
        type: f.type,
        requiredBalance: null,
        available: null,
        balances: [],
        overage: null,
        nextResetAt: null,
      };
    }

    const required = parsePositive(input.requiredBalance, "requiredBalance", qty(1));
    const pools = view(ctx, f.id);
    const allowed = canCover(pools, required, ctx.now);
    const result: CheckResult = {
      allowed,
      customerId: ctx.customerId,
      featureId: f.id,
      type: f.type,
      requiredBalance: formatQty(required),
      available: formatQty(available(pools, ctx.now)),
      balances: balancesOf(pools, ctx.now),
      overage: overageView(pools),
      nextResetAt: nextResetAt(pools, ctx.now),
    };
    if (!allowed) return result;

    if (input.sendEvent) {
      result.event = await trackInCtx(ctx, {
        featureId: f.id,
        value: formatQty(required),
        idempotencyKey: input.idempotencyKey,
        properties: input.properties,
      });
    } else if (input.lock) {
      if (f.type === "credit_system") throw new BillError("invalid_request", "lock the underlying feature, not the credit system");
      if (input.lock.expiresAt.getTime() <= ctx.now.getTime()) throw new BillError("invalid_request", "lock.expiresAt is in the past");
      const [existing] = await ctx.tx
        .select({ lockId: locks.lockId })
        .from(locks)
        .where(and(eq(locks.orgId, scope.orgId), eq(locks.env, scope.env), eq(locks.lockId, input.lock.lockId)));
      if (existing) throw new BillError("lock_exists", `lock ${input.lock.lockId} already exists`);

      const r = planDeduction(pools, required, ctx.now);
      await applyDeduction(ctx, r, "lock", { lockId: input.lock.lockId });
      if (r.overage) await accrue(ctx, pools, r.overage, "held");
      await ctx.tx.insert(locks).values({
        ...scope,
        lockId: input.lock.lockId,
        customerId: ctx.customerId,
        featureId: f.id,
        held: formatQty(required),
        allocations: r.allocations.map((a) => ({ ...a, amount: formatQty(a.amount) })),
        overage: r.overage
          ? { ...r.overage, periodStart: r.overage.periodStart.toISOString(), units: formatQty(r.overage.units) }
          : null,
        expiresAt: input.lock.expiresAt,
      });
      await refresh(ctx);
      const after = view(ctx, f.id);
      result.available = formatQty(available(after, ctx.now));
      result.balances = balancesOf(after, ctx.now);
      result.overage = overageView(after);
      result.lock = { lockId: input.lock.lockId, expiresAt: input.lock.expiresAt.toISOString() };
    }
    return result;
  });
}

// ------------------------------------------------------------------ finalize

export async function finalize(db: Db, scope: Scope, input: FinalizeInput) {
  const [found] = await db
    .select({ customerId: locks.customerId })
    .from(locks)
    .where(and(eq(locks.orgId, scope.orgId), eq(locks.env, scope.env), eq(locks.lockId, input.lockId)));
  if (!found) throw new BillError("lock_not_found", `lock ${input.lockId} not found`);

  return inCustomerTx(
    db,
    scope,
    found.customerId,
    async (ctx) => {
      // Re-read under the customer lock; expired locks were released on entry.
      const [lock] = await ctx.tx
        .select()
        .from(locks)
        .where(and(eq(locks.orgId, scope.orgId), eq(locks.env, scope.env), eq(locks.lockId, input.lockId)));
      if (!lock) throw new BillError("lock_not_found", `lock ${input.lockId} not found`);
      if (lock.status === "expired") throw new BillError("lock_expired", `lock ${input.lockId} expired at ${lock.expiresAt.toISOString()} and was released`);
      if (lock.status !== "held") {
        // Finalising twice with the same action is a no-op that returns the first outcome.
        const sameAction = (lock.status === "confirmed") === (input.action === "confirm");
        if (!sameAction) throw new BillError("lock_finalized", `lock ${input.lockId} is already ${lock.status}`);
        const [ev] = lock.usageEventId
          ? await ctx.tx.select({ result: usageEvents.result }).from(usageEvents).where(eq(usageEvents.id, lock.usageEventId))
          : [];
        return { lockId: lock.lockId, status: lock.status, event: ev ? { ...(ev.result as TrackResult), replayed: true } : null };
      }

      // Return the hold, then record the real usage as a normal track (rule 8).
      await releaseLock(ctx.tx, scope, lock, input.action === "confirm" ? "confirmed" : "released", ctx.now);
      await refresh(ctx);
      if (input.action === "release") return { lockId: lock.lockId, status: "released" as const, event: null };

      const event = await trackInCtx(ctx, {
        featureId: lock.featureId,
        value: input.overrideValue ?? lock.held,
        idempotencyKey: `lock:${lock.lockId}`,
        properties: input.properties,
      });
      await ctx.tx
        .update(locks)
        .set({ usageEventId: event.id })
        .where(and(eq(locks.orgId, scope.orgId), eq(locks.env, scope.env), eq(locks.lockId, lock.lockId)));
      return { lockId: lock.lockId, status: "confirmed" as const, event };
    },
    { create: false },
  );
}
