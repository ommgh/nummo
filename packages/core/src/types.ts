import type { OveragePrice } from "./money.ts";
import type { Qty } from "./qty.ts";

export type FeatureType = "boolean" | "metered" | "credit_system";

export type GrantSource = "plan" | "topup" | "manual" | "reward";

/** An amount of a feature given to a customer (doc 02, "Grant"). */
export type Grant = {
  id: string;
  featureId: string;
  source: GrantSource;
  amount: Qty;
  /** Cached: amount plus the sum of this grant's ledger entries. Never negative. */
  remaining: Qty;
  /** Reset interval in hours, or null if the grant never resets. Drives deduction order. */
  resetHours: number | null;
  /** The grant is inactive at and after this instant. Null means it never expires. */
  expiresAt: Date | null;
  createdAt: Date;
  /** For plan grants: the subscription and period they were issued for. */
  subscriptionId?: string | null;
  periodStart?: Date | null;
};

/** Overage terms for one pool, with what has already been used this period. */
export type OveragePolicy = {
  price: OveragePrice;
  /** Where accrued overage is recorded: the subscription and its current billing period. */
  subscriptionId: string;
  periodStart: Date;
  /** Overage units already accrued this period, including units held by open locks. */
  usedUnits: Qty;
  /**
   * True when overage must not grow, for example while the subscription is
   * past due (ledger rule 6).
   */
  blocked: boolean;
};

/**
 * A balance a feature can draw from: the feature's own grants (rate 1), or a
 * credit system's grants at the feature's credit rate.
 */
export type Pool = {
  /** The feature whose grants make up this pool. */
  featureId: string;
  /** Pool units consumed per unit of the requested feature. 1 for a direct pool. */
  rate: Qty;
  grants: readonly Grant[];
  overage: OveragePolicy | null;
};

export type Allocation = {
  grantId: string;
  featureId: string;
  /** Pool units taken from this grant. Always positive. */
  amount: Qty;
};

export type DeductionResult = {
  allocations: Allocation[];
  /** Overage accrued, in units of `featureId` (the pool that carries overage). */
  overage: { featureId: string; units: Qty; subscriptionId: string; periodStart: Date } | null;
  /**
   * Units of the requested feature that were neither covered by a balance nor
   * billable as overage. Non-zero means `check` would refuse.
   */
  unabsorbed: Qty;
};
