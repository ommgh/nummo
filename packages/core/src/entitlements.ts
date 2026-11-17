/**
 * Turning a customer's plan items into grants, and period resets (rule 9).
 *
 * Resets are lazy: whenever a customer's balance is read or changed, the caller
 * runs `reconcileGrants` first. That makes the result independent of whether a
 * scheduled job ran on time, and it needs no cron in milestone M1.
 */

import type { OveragePrice } from "./money.ts";
import { isActive } from "./ledger.ts";
import { type Period, periodAt } from "./period.ts";
import type { Qty } from "./qty.ts";
import type { Grant } from "./types.ts";

export type ResetRule = { kind: "never" } | { kind: "every"; hours: number };

/** One plan item, as attached to a customer through a subscription. */
export type EntitlementItem = {
  subscriptionId: string;
  featureId: string;
  /** Included amount per reset. Null for boolean features. */
  included: Qty | null;
  reset: ResetRule;
  /**
   * Where this subscription's periods are counted from: the on-chain period
   * start for paid plans, the attach time for free plans (rule 9).
   */
  periodAnchor: Date;
  /** Billing period of the subscription in hours; overage accrues per billing period. */
  billingPeriodHours: number;
  overage: OveragePrice | null;
};

export type GrantChanges = {
  /** New plan grants to insert. */
  create: Grant[];
  /** Grants that have expired with a non-zero remainder; write an `expiry` entry for each. */
  expire: Grant[];
};

export function currentResetPeriod(item: EntitlementItem, now: Date): Period | null {
  return item.reset.kind === "every" ? periodAt(item.periodAnchor, item.reset.hours, now) : null;
}

export function currentBillingPeriod(item: Pick<EntitlementItem, "periodAnchor" | "billingPeriodHours">, now: Date): Period {
  return periodAt(item.periodAnchor, item.billingPeriodHours, now);
}

export function reconcileGrants(
  items: readonly EntitlementItem[],
  grants: readonly Grant[],
  now: Date,
  newId: () => string,
): GrantChanges {
  const expire = grants.filter((g) => !isActive(g, now) && g.remaining !== 0n);
  const create: Grant[] = [];

  for (const item of items) {
    if (item.included === null || item.included <= 0n) continue;
    const planGrants = grants.filter(
      (g) => g.source === "plan" && g.subscriptionId === item.subscriptionId && g.featureId === item.featureId,
    );

    if (item.reset.kind === "never") {
      if (planGrants.length === 0) {
        create.push(planGrant(item, newId(), now, null, null, null));
      }
      continue;
    }

    const period = periodAt(item.periodAnchor, item.reset.hours, now);
    const exists = planGrants.some((g) => g.periodStart?.getTime() === period.start.getTime());
    if (!exists) {
      create.push(planGrant(item, newId(), now, item.reset.hours, period.end, period.start));
    }
  }

  return { create, expire };
}

function planGrant(
  item: EntitlementItem,
  id: string,
  now: Date,
  resetHours: number | null,
  expiresAt: Date | null,
  periodStart: Date | null,
): Grant {
  return {
    id,
    featureId: item.featureId,
    source: "plan",
    amount: item.included!,
    remaining: item.included!,
    resetHours,
    expiresAt,
    createdAt: now,
    subscriptionId: item.subscriptionId,
    periodStart,
  };
}
