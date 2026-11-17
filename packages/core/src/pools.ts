/**
 * Assemble the pools a feature draws from, for one customer at one instant.
 */

import { currentBillingPeriod, type EntitlementItem } from "./entitlements.ts";
import type { Qty } from "./qty.ts";
import { QTY_SCALE } from "./qty.ts";
import type { FeatureType, Grant, OveragePolicy, Pool } from "./types.ts";

export type FeatureDef = {
  id: string;
  type: FeatureType;
};

/** The pricing config, as the hot path needs it. */
export type Catalog = {
  features: ReadonlyMap<string, FeatureDef>;
  /** For a metered feature drawn from a credit system: which one, and at what rate (rule 4). */
  creditRates: ReadonlyMap<string, { creditFeatureId: string; rate: Qty }>;
};

/** What the database knows about one customer, loaded under the customer's row lock. */
export type CustomerSnapshot = {
  grants: readonly Grant[];
  /** Items of the customer's live subscriptions (active, past_due or canceling). */
  items: readonly EntitlementItem[];
  /**
   * Overage units already accrued in the current billing period, including
   * units held by open locks. Keyed by `accrualKey(subscriptionId, featureId)`.
   */
  overageUsed: ReadonlyMap<string, Qty>;
  /** Subscriptions whose overage is blocked, for example while past due (rule 6). */
  overageBlocked: ReadonlySet<string>;
};

export function accrualKey(subscriptionId: string, featureId: string): string {
  return `${subscriptionId}\u0000${featureId}`;
}

function overageFor(snapshot: CustomerSnapshot, featureId: string, now: Date): OveragePolicy | null {
  const item = snapshot.items.find((i) => i.featureId === featureId && i.overage !== null);
  if (!item || !item.overage) return null;
  const period = currentBillingPeriod(item, now);
  return {
    price: item.overage,
    subscriptionId: item.subscriptionId,
    periodStart: period.start,
    usedUnits: snapshot.overageUsed.get(accrualKey(item.subscriptionId, featureId)) ?? 0n,
    blocked: snapshot.overageBlocked.has(item.subscriptionId),
  };
}

/**
 * Pools for `featureId`, direct balance first, then its credit system (rule 3).
 * Callers always name the underlying feature, never the credit system (rule 4).
 */
export function poolsFor(catalog: Catalog, snapshot: CustomerSnapshot, featureId: string, now: Date): Pool[] {
  const pools: Pool[] = [];
  const direct = snapshot.grants.filter((g) => g.featureId === featureId);
  const directOverage = overageFor(snapshot, featureId, now);
  const entitledDirect = snapshot.items.some((i) => i.featureId === featureId);
  if (direct.length > 0 || directOverage || entitledDirect) {
    pools.push({ featureId, rate: QTY_SCALE, grants: direct, overage: directOverage });
  }

  const credit = catalog.creditRates.get(featureId);
  if (credit) {
    pools.push({
      featureId: credit.creditFeatureId,
      rate: credit.rate,
      grants: snapshot.grants.filter((g) => g.featureId === credit.creditFeatureId),
      overage: overageFor(snapshot, credit.creditFeatureId, now),
    });
  }
  return pools;
}

/** A boolean feature is allowed when any live subscription includes it. */
export function hasBooleanFeature(snapshot: CustomerSnapshot, featureId: string): boolean {
  return snapshot.items.some((i) => i.featureId === featureId);
}
