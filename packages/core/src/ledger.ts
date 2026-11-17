/**
 * The ledger rules from doc 02, as pure functions.
 *
 * Nothing here does I/O. The database layer loads the customer's grants under a
 * row lock, calls these functions, and writes the result back.
 */

import { maxOverageUnits } from "./money.ts";
import { type Qty, divCeil, minQty, mulQtyUp, QTY_SCALE, sumQty } from "./qty.ts";
import type { Allocation, DeductionResult, Grant, Pool } from "./types.ts";

export function isActive(g: Grant, now: Date): boolean {
  return g.expiresAt === null || g.expiresAt.getTime() > now.getTime();
}

/**
 * Rule 3, deduction order: grants that reset on a shorter interval first; among
 * equal intervals, the one expiring soonest; grants that never expire last.
 * Ties break on creation time then id, so the order is total and deterministic.
 */
export function compareForDeduction(a: Grant, b: Grant): number {
  const ra = a.resetHours ?? Number.POSITIVE_INFINITY;
  const rb = b.resetHours ?? Number.POSITIVE_INFINITY;
  if (ra !== rb) return ra < rb ? -1 : 1;
  const ea = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const eb = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (ea !== eb) return ea < eb ? -1 : 1;
  const ca = a.createdAt.getTime();
  const cb = b.createdAt.getTime();
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function deductionOrder(grants: readonly Grant[], now: Date): Grant[] {
  return grants.filter((g) => isActive(g, now) && g.remaining > 0n).sort(compareForDeduction);
}

/** Rule 2: a balance is the sum of unexpired grants' `remaining`. */
export function poolBalance(pool: Pool, now: Date): Qty {
  return sumQty(pool.grants.filter((g) => isActive(g, now)).map((g) => g.remaining));
}

/** Overage units this pool can still accrue this period (0 if none or blocked). */
export function overageHeadroom(pool: Pool): Qty {
  const o = pool.overage;
  if (!o || o.blocked) return 0n;
  const left = maxOverageUnits(o.price) - o.usedUnits;
  return left > 0n ? left : 0n;
}

/** Convert pool units back to units of the requested feature, rounding down. */
function toRequested(poolUnits: Qty, rate: Qty): Qty {
  return (poolUnits * QTY_SCALE) / rate;
}

/** Convert units of the requested feature into pool units, rounding up. */
function toPool(requested: Qty, rate: Qty): Qty {
  return mulQtyUp(requested, rate);
}

/**
 * Plan how `value` units of a feature are covered.
 *
 * Pools are tried in the order given: the caller passes the direct pool before
 * the credit system pool (rule 3, last sentence; rule 4). What is left after
 * every pool goes to overage on the last pool that offers it (rule 5), bounded
 * by the cap (rule 6). Anything beyond that is `unabsorbed`.
 */
export function planDeduction(pools: readonly Pool[], value: Qty, now: Date): DeductionResult {
  if (value < 0n) throw new RangeError("usage value must not be negative");
  const allocations: Allocation[] = [];
  let left = value; // in units of the requested feature
  // Exact shortfall of the last pool tried, in its own units. Kept so the
  // overage step does not round a second time.
  let lastPool: Pool | null = null;
  let lastShortfall = 0n;

  for (const pool of pools) {
    if (left === 0n) break;
    if (pool.rate <= 0n) throw new RangeError(`pool ${pool.featureId} has a non-positive rate`);
    const need = toPool(left, pool.rate);
    let taken = 0n;
    for (const g of deductionOrder(pool.grants, now)) {
      if (taken === need) break;
      const take = minQty(g.remaining, need - taken);
      allocations.push({ grantId: g.id, featureId: pool.featureId, amount: take });
      taken += take;
    }
    lastPool = pool;
    lastShortfall = need - taken;
    // Credit the customer only for what this pool fully covered (rounding down),
    // so an empty or partly empty pool never inflates what is left.
    left = lastShortfall === 0n ? 0n : left - toRequested(taken, pool.rate);
  }

  if (left === 0n) return { allocations, overage: null, unabsorbed: 0n };

  const overagePool = [...pools].reverse().find((p) => p.overage !== null);
  if (!overagePool) return { allocations, overage: null, unabsorbed: left };

  const wanted = overagePool === lastPool ? lastShortfall : toPool(left, overagePool.rate);
  const billable = minQty(wanted, overageHeadroom(overagePool));
  const unabsorbedPool = wanted - billable;
  return {
    allocations,
    overage:
      billable > 0n
        ? {
            featureId: overagePool.featureId,
            units: billable,
            subscriptionId: overagePool.overage!.subscriptionId,
            periodStart: overagePool.overage!.periodStart,
          }
        : null,
    unabsorbed: unabsorbedPool === 0n ? 0n : divCeil(unabsorbedPool * QTY_SCALE, overagePool.rate),
  };
}

/** How much of the requested feature the customer could use right now, balance plus overage headroom. */
export function available(pools: readonly Pool[], now: Date): Qty {
  // Only the last pool that offers overage carries it, as in planDeduction.
  const overagePool = [...pools].reverse().find((p) => p.overage !== null);
  return sumQty(
    pools.map((p) => toRequested(poolBalance(p, now) + (p === overagePool ? overageHeadroom(p) : 0n), p.rate)),
  );
}

/**
 * Rule 5: `check` allows usage when the full amount can be covered. Answered by
 * simulating the deduction, so `check` and `track` can never disagree.
 */
export function canCover(pools: readonly Pool[], value: Qty, now: Date): boolean {
  return planDeduction(pools, value, now).unabsorbed === 0n;
}

/** Apply allocations to grants: returns new grant objects with `remaining` reduced. */
export function applyAllocations(grants: readonly Grant[], allocations: readonly Allocation[], sign: 1n | -1n = 1n): Grant[] {
  const byId = new Map<string, Qty>();
  for (const a of allocations) byId.set(a.grantId, (byId.get(a.grantId) ?? 0n) + a.amount);
  return grants.map((g) => {
    const d = byId.get(g.id);
    if (d === undefined) return g;
    const remaining = g.remaining - sign * d;
    if (remaining < 0n) throw new RangeError(`grant ${g.id} would go negative`);
    if (remaining > g.amount) throw new RangeError(`grant ${g.id} would exceed its amount`);
    return { ...g, remaining };
  });
}
