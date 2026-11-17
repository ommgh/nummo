import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  type Allocation,
  type Grant,
  type OveragePolicy,
  type Pool,
  applyAllocations,
  available,
  canCover,
  deductionOrder,
  isActive,
  maxOverageUnits,
  overageCost,
  overageHeadroom,
  planDeduction,
  poolBalance,
  qty,
  QTY_SCALE,
  sumQty,
  usdc,
} from "../src/index.ts";

const NOW = new Date("2026-11-17T12:00:00Z");
const H = 3_600_000;

let seq = 0;
function grant(p: Partial<Grant> & { amount: bigint }): Grant {
  return {
    id: p.id ?? `g${++seq}`,
    featureId: p.featureId ?? "credits",
    source: p.source ?? "plan",
    amount: p.amount,
    remaining: p.remaining ?? p.amount,
    resetHours: p.resetHours === undefined ? 720 : p.resetHours,
    expiresAt: p.expiresAt === undefined ? new Date(NOW.getTime() + 10 * H) : p.expiresAt,
    createdAt: p.createdAt ?? new Date(NOW.getTime() - H),
  };
}

function overage(cap: string, used = 0n, blocked = false): OveragePolicy {
  return {
    price: { price: usdc("0.01"), per: qty(1), cap: usdc(cap) },
    subscriptionId: "sub_1",
    periodStart: new Date(NOW.getTime() - H),
    usedUnits: used,
    blocked,
  };
}

const total = (as: Allocation[]) => sumQty(as.map((a) => a.amount));

describe("deduction order (rule 3)", () => {
  test("shorter reset interval first, then soonest expiry, never-expiring last", () => {
    const monthly = grant({ id: "monthly", amount: qty(10), resetHours: 720 });
    const daily = grant({ id: "daily", amount: qty(10), resetHours: 24 });
    const topupSoon = grant({ id: "topupSoon", amount: qty(10), resetHours: null, expiresAt: new Date(NOW.getTime() + 2 * H) });
    const topupLater = grant({ id: "topupLater", amount: qty(10), resetHours: null, expiresAt: new Date(NOW.getTime() + 9 * H) });
    const forever = grant({ id: "forever", amount: qty(10), resetHours: null, expiresAt: null });
    const order = deductionOrder([forever, topupLater, monthly, topupSoon, daily], NOW).map((g) => g.id);
    expect(order).toEqual(["daily", "monthly", "topupSoon", "topupLater", "forever"]);
  });

  test("expired and empty grants are skipped", () => {
    const expired = grant({ id: "expired", amount: qty(10), expiresAt: new Date(NOW.getTime() - 1) });
    const empty = grant({ id: "empty", amount: qty(10), remaining: 0n });
    const ok = grant({ id: "ok", amount: qty(10) });
    expect(deductionOrder([expired, empty, ok], NOW).map((g) => g.id)).toEqual(["ok"]);
    expect(isActive(expired, NOW)).toBe(false);
  });

  test("a grant expiring exactly now is inactive", () => {
    expect(isActive(grant({ amount: 1n, expiresAt: NOW }), NOW)).toBe(false);
  });
});

describe("planDeduction, the doc 04 example", () => {
  // Pro: 1000 credits included; premium message = 10 credits; overage 0.01/credit capped at 50 USDC.
  const credits = (g: Grant[], o: OveragePolicy | null = overage("50")): Pool => ({
    featureId: "credits",
    rate: qty(10),
    grants: g,
    overage: o,
  });

  test("a premium message draws 10 credits", () => {
    const g = grant({ id: "plan", amount: qty(1000) });
    const r = planDeduction([credits([g])], qty(1), NOW);
    expect(r.allocations).toEqual([{ grantId: "plan", featureId: "credits", amount: qty(10) }]);
    expect(r.overage).toBeNull();
    expect(r.unabsorbed).toBe(0n);
  });

  test("direct balance is used before the credit system (rule 3)", () => {
    const direct: Pool = { featureId: "premium_message", rate: QTY_SCALE, grants: [grant({ id: "d", featureId: "premium_message", amount: qty(2) })], overage: null };
    const r = planDeduction([direct, credits([grant({ id: "c", amount: qty(1000) })])], qty(3), NOW);
    expect(r.allocations).toEqual([
      { grantId: "d", featureId: "premium_message", amount: qty(2) },
      { grantId: "c", featureId: "credits", amount: qty(10) },
    ]);
  });

  test("past the included credits, overage accrues", () => {
    const g = grant({ id: "plan", amount: qty(1000), remaining: qty(5) });
    const r = planDeduction([credits([g])], qty(1), NOW);
    expect(total(r.allocations)).toBe(qty(5));
    expect(r.overage?.units).toBe(qty(5));
    expect(r.unabsorbed).toBe(0n);
  });

  test("overage stops at the cap (rule 6): 50 USDC = 5000 credits", () => {
    const g = grant({ amount: qty(1000), remaining: 0n });
    const almost = credits([g], overage("50", qty(4995)));
    const r = planDeduction([almost], qty(1), NOW); // needs 10 credits, 5 left under the cap
    expect(r.overage?.units).toBe(qty(5));
    expect(r.unabsorbed).toBe(qty("0.5"));
    expect(canCover([almost], qty(1), NOW)).toBe(false);
    expect(canCover([almost], qty("0.5"), NOW)).toBe(true);
  });

  test("blocked overage (past due) refuses once the balance is gone", () => {
    const g = grant({ amount: qty(1000), remaining: qty(10) });
    const pools = [credits([g], overage("50", 0n, true))];
    expect(canCover(pools, qty(1), NOW)).toBe(true);
    expect(canCover(pools, qty(2), NOW)).toBe(false);
  });

  test("no overage price: refuse at zero (rule 5), free plan", () => {
    const free = credits([grant({ amount: qty(100), remaining: qty(9) })], null);
    expect(canCover([free], qty(1), NOW)).toBe(false);
    const r = planDeduction([free], qty(1), NOW);
    expect(total(r.allocations)).toBe(qty(9));
    expect(r.unabsorbed).toBe(qty("0.1"));
  });

  test("available() reports balance plus overage headroom in feature units", () => {
    const pools = [credits([grant({ amount: qty(1000), remaining: qty(100) })], overage("1"))];
    // 100 credits + 1 USDC / 0.01 = 100 credits of overage = 200 credits = 20 premium messages.
    expect(available(pools, NOW)).toBe(qty(20));
  });
});

describe("applyAllocations", () => {
  test("refuses to take a grant negative or above its amount", () => {
    const g = grant({ id: "a", amount: qty(5) });
    expect(() => applyAllocations([g], [{ grantId: "a", featureId: "credits", amount: qty(6) }])).toThrow(RangeError);
    expect(() => applyAllocations([g], [{ grantId: "a", featureId: "credits", amount: 1n }], -1n)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------- properties

const arbGrant = (featureId: string) =>
  fc
    .record({
      amount: fc.bigInt({ min: 1n, max: qty(1000) }),
      usedFraction: fc.integer({ min: 0, max: 100 }),
      resetHours: fc.constantFrom(null, 1, 24, 720),
      expiresInH: fc.option(fc.integer({ min: -5, max: 1000 }), { nil: null }),
      createdAgoH: fc.integer({ min: 0, max: 100 }),
    })
    .map(
      (r): Grant => ({
        id: `${featureId}_${Math.random().toString(36).slice(2)}`,
        featureId,
        source: "plan",
        amount: r.amount,
        remaining: (r.amount * BigInt(100 - r.usedFraction)) / 100n,
        resetHours: r.resetHours,
        expiresAt: r.expiresInH === null ? null : new Date(NOW.getTime() + r.expiresInH * H),
        createdAt: new Date(NOW.getTime() - r.createdAgoH * H),
      }),
    );

const arbOverage = fc.option(
  fc.record({
    cap: fc.bigInt({ min: 0n, max: usdc("100") }),
    price: fc.bigInt({ min: 1n, max: usdc("1") }),
    usedPct: fc.integer({ min: 0, max: 120 }),
    blocked: fc.boolean(),
  }),
  { nil: null },
).map((o): OveragePolicy | null => {
  if (!o) return null;
  const price = { price: o.price, per: qty(1), cap: o.cap };
  return {
    price,
    subscriptionId: "sub",
    periodStart: NOW,
    usedUnits: (maxOverageUnits(price) * BigInt(o.usedPct)) / 100n,
    blocked: o.blocked,
  };
});

const arbPools = fc
  .record({
    direct: fc.option(fc.record({ grants: fc.array(arbGrant("feat"), { maxLength: 5 }), overage: arbOverage }), { nil: null }),
    credit: fc.option(
      fc.record({
        rate: fc.constantFrom(qty("0.5"), qty(1), qty(10), qty("2.5")),
        grants: fc.array(arbGrant("credits"), { maxLength: 5 }),
        overage: arbOverage,
      }),
      { nil: null },
    ),
  })
  .map(({ direct, credit }) => {
    const pools: Pool[] = [];
    if (direct) pools.push({ featureId: "feat", rate: QTY_SCALE, grants: direct.grants, overage: direct.overage });
    if (credit) pools.push({ featureId: "credits", rate: credit.rate, grants: credit.grants, overage: credit.overage });
    return pools;
  });

const arbValue = fc.bigInt({ min: 0n, max: qty(500) });

describe("ledger properties", () => {
  test("allocations only touch active grants, never exceed remaining, and stay in their pool", () => {
    fc.assert(
      fc.property(arbPools, arbValue, (pools, value) => {
        const r = planDeduction(pools, value, NOW);
        const byId = new Map(pools.flatMap((p) => p.grants.map((g) => [g.id, { g, pool: p.featureId }] as const)));
        const taken = new Map<string, bigint>();
        for (const a of r.allocations) {
          const entry = byId.get(a.grantId)!;
          expect(entry).toBeDefined();
          expect(entry.pool).toBe(a.featureId);
          expect(isActive(entry.g, NOW)).toBe(true);
          expect(a.amount > 0n).toBe(true);
          taken.set(a.grantId, (taken.get(a.grantId) ?? 0n) + a.amount);
        }
        for (const [id, t] of taken) expect(t <= byId.get(id)!.g.remaining).toBe(true);
        // Applying never yields a negative grant.
        for (const p of pools) {
          for (const g of applyAllocations(p.grants, r.allocations.filter((a) => a.featureId === p.featureId))) {
            expect(g.remaining >= 0n).toBe(true);
          }
        }
      }),
    );
  });

  test("deduction order is respected, and a later pool is only touched once earlier pools are empty", () => {
    fc.assert(
      fc.property(arbPools, arbValue, (pools, value) => {
        const r = planDeduction(pools, value, NOW);
        const taken = new Map<string, bigint>();
        for (const a of r.allocations) taken.set(a.grantId, (taken.get(a.grantId) ?? 0n) + a.amount);
        let earlierPoolHasLeft = false;
        for (const p of pools) {
          const order = deductionOrder(p.grants, NOW);
          const touched = order.some((g) => taken.has(g.id));
          if (touched) expect(earlierPoolHasLeft).toBe(false);
          let sawPartial = false;
          for (const g of order) {
            const t = taken.get(g.id) ?? 0n;
            if (sawPartial) expect(t).toBe(0n);
            if (t < g.remaining) sawPartial = true;
          }
          if (poolBalance(p, NOW) > sumQty(order.map((g) => taken.get(g.id) ?? 0n))) earlierPoolHasLeft = true;
        }
        // Overage only once every pool is drained.
        if (r.overage) expect(earlierPoolHasLeft).toBe(false);
      }),
    );
  });

  test("overage respects the cap and is zero when blocked (rule 6)", () => {
    fc.assert(
      fc.property(arbPools, arbValue, (pools, value) => {
        const r = planDeduction(pools, value, NOW);
        if (!r.overage) return;
        const pool = pools.find((p) => p.featureId === r.overage!.featureId)!;
        expect(pool.overage!.blocked).toBe(false);
        expect(r.overage.units <= overageHeadroom(pool)).toBe(true);
        expect(overageCost(pool.overage!.usedUnits + r.overage.units, pool.overage!.price) <= pool.overage!.price.cap).toBe(true);
      }),
    );
  });

  test("with a single direct pool, covered + overage + unabsorbed equals the value exactly", () => {
    fc.assert(
      fc.property(fc.array(arbGrant("feat"), { maxLength: 6 }), arbOverage, arbValue, (grants, o, value) => {
        const pools: Pool[] = [{ featureId: "feat", rate: QTY_SCALE, grants, overage: o }];
        const r = planDeduction(pools, value, NOW);
        expect(total(r.allocations) + (r.overage?.units ?? 0n) + r.unabsorbed).toBe(value);
      }),
    );
  });

  test("check and track agree, and check is monotonic", () => {
    fc.assert(
      fc.property(arbPools, arbValue, arbValue, (pools, a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(canCover(pools, a, NOW)).toBe(planDeduction(pools, a, NOW).unabsorbed === 0n);
        if (canCover(pools, hi, NOW)) expect(canCover(pools, lo, NOW)).toBe(true);
      }),
    );
  });

  test("whatever available() reports can actually be covered", () => {
    fc.assert(
      fc.property(arbPools, (pools) => {
        expect(canCover(pools, available(pools, NOW), NOW)).toBe(true);
      }),
    );
  });

  test("a sequence of tracks and lock releases keeps every grant equal to amount minus net allocations (rule 2)", () => {
    type Op = { kind: "track"; value: bigint } | { kind: "lock"; value: bigint } | { kind: "release"; which: number };
    const arbOp: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ kind: fc.constant("track" as const), value: fc.bigInt({ min: 0n, max: qty(50) }) }),
      fc.record({ kind: fc.constant("lock" as const), value: fc.bigInt({ min: 0n, max: qty(50) }) }),
      fc.record({ kind: fc.constant("release" as const), which: fc.nat(10) }),
    );
    fc.assert(
      fc.property(fc.array(arbGrant("credits"), { minLength: 1, maxLength: 5 }), fc.array(arbOp, { maxLength: 30 }), (initial, ops) => {
        let grants = initial;
        const net = new Map<string, bigint>(); // grant id -> net amount taken by us
        const locks: Allocation[][] = [];
        const pool = (): Pool[] => [{ featureId: "credits", rate: QTY_SCALE, grants, overage: null }];
        for (const op of ops) {
          if (op.kind === "release") {
            const held = locks.splice(op.which % Math.max(locks.length, 1), 1)[0];
            if (!held) continue;
            grants = applyAllocations(grants, held, -1n);
            for (const a of held) net.set(a.grantId, (net.get(a.grantId) ?? 0n) - a.amount);
            continue;
          }
          // A lock is only taken when check allows it; a track always records.
          if (op.kind === "lock" && !canCover(pool(), op.value, NOW)) continue;
          const r = planDeduction(pool(), op.value, NOW);
          grants = applyAllocations(grants, r.allocations);
          for (const a of r.allocations) net.set(a.grantId, (net.get(a.grantId) ?? 0n) + a.amount);
          if (op.kind === "lock") locks.push(r.allocations);
        }
        const start = new Map(initial.map((g) => [g.id, g.remaining]));
        for (const g of grants) {
          expect(g.remaining).toBe(start.get(g.id)! - (net.get(g.id) ?? 0n));
          expect(g.remaining >= 0n && g.remaining <= g.amount).toBe(true);
        }
      }),
    );
  });
});
