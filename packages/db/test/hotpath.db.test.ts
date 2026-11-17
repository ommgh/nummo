import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { toDocument, usdc } from "@usenummo/config";
import {
  applyConfig,
  attach,
  NummoError,
  check,
  finalize,
  getCustomer,
  grantBalance,
  listEvents,
  track,
  trackBatch,
  upsertCustomer,
  type Db,
} from "../src/index.ts";
import { closeTestDb, exampleConfig, ledgerDrift, testDb, withExampleConfig } from "./helpers.ts";

let db: Db;
beforeAll(async () => {
  db = await testDb();
});
afterAll(closeTestDb);

const credits = async (scope: Parameters<typeof getCustomer>[1], id: string) =>
  (await getCustomer(db, scope, id)).balances.find((b) => b.featureId === "credits")?.balance;

describe("free plan, end to end (M1 done-when #1)", () => {
  test("a new customer gets 100 credits, chats, and is blocked at zero", async () => {
    const scope = await withExampleConfig(db);
    // check auto-creates the customer on the default plan.
    const first = await check(db, scope, { customerId: "u1", featureId: "premium_message" });
    expect(first.allowed).toBe(true);
    expect(first.balances).toEqual([{ featureId: "credits", balance: "100", rate: "10" }]);
    expect(first.available).toBe("10");
    expect(first.nextResetAt).not.toBeNull();

    for (let i = 0; i < 9; i++) await track(db, scope, { customerId: "u1", featureId: "premium_message", value: "1" });
    await track(db, scope, { customerId: "u1", featureId: "basic_message", value: "5" });
    expect(await credits(scope, "u1")).toBe("5");

    expect((await check(db, scope, { customerId: "u1", featureId: "premium_message" })).allowed).toBe(false);
    expect((await check(db, scope, { customerId: "u1", featureId: "basic_message", requiredBalance: "5" })).allowed).toBe(true);
    expect((await check(db, scope, { customerId: "u1", featureId: "basic_message", requiredBalance: "6" })).allowed).toBe(false);

    // track past zero records the event but never takes the balance negative (rule 5).
    const over = await track(db, scope, { customerId: "u1", featureId: "premium_message", value: "1" });
    expect(over.deducted).toEqual([{ featureId: "credits", amount: "5" }]);
    expect(over.unabsorbed).toBe("0.5");
    expect(over.overage).toBeNull();
    expect(await credits(scope, "u1")).toBe("0");

    // Boolean feature not on the free plan.
    expect((await check(db, scope, { customerId: "u1", featureId: "sso" })).allowed).toBe(false);
    expect(await ledgerDrift(db, scope)).toEqual([]);

    const outbox = await db.execute(sql`select event_type from outbox where org_id = ${scope.orgId} order by id`);
    expect(outbox.rows.map((r) => r.event_type)).toEqual(["balance.low", "balance.depleted"]);
  });

  test("check with sendEvent deducts only when allowed", async () => {
    const scope = await withExampleConfig(db);
    const r = await check(db, scope, { customerId: "u", featureId: "premium_message", requiredBalance: "10", sendEvent: true });
    expect(r.allowed).toBe(true);
    expect(r.event?.deducted).toEqual([{ featureId: "credits", amount: "100" }]);
    const refused = await check(db, scope, { customerId: "u", featureId: "premium_message", sendEvent: true });
    expect(refused.allowed).toBe(false);
    expect(refused.event).toBeUndefined();
  });
});

describe("idempotency (rule 7)", () => {
  test("a repeated key returns the first result and changes nothing", async () => {
    const scope = await withExampleConfig(db);
    const a = await track(db, scope, { customerId: "u", featureId: "premium_message", value: "1", idempotencyKey: "req-1" });
    const b = await track(db, scope, { customerId: "u", featureId: "premium_message", value: "3", idempotencyKey: "req-1" });
    expect(b).toEqual({ ...a, replayed: true });
    expect(await credits(scope, "u")).toBe("90");
    expect(await listEvents(db, scope, { customerId: "u" })).toHaveLength(1);
  });

  test("concurrent duplicates still record once", async () => {
    const scope = await withExampleConfig(db);
    await upsertCustomer(db, scope, { id: "u" });
    const rs = await Promise.all(
      Array.from({ length: 20 }, () => track(db, scope, { customerId: "u", featureId: "basic_message", value: "1", idempotencyKey: "same" })),
    );
    expect(rs.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await credits(scope, "u")).toBe("99");
  });
});

describe("concurrency (M1 done-when #3)", () => {
  test("100 parallel gated tracks on one customer never oversell", async () => {
    const scope = await withExampleConfig(db);
    await upsertCustomer(db, scope, { id: "hot" });
    // 100 credits, each premium message costs 10: exactly 10 may succeed.
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        check(db, scope, { customerId: "hot", featureId: "premium_message", sendEvent: true, idempotencyKey: `k${i}` }),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(await credits(scope, "hot")).toBe("0");
    expect(await ledgerDrift(db, scope)).toEqual([]);
  });

  test("100 parallel ungated tracks deduct exactly once each and never go negative", async () => {
    const scope = await withExampleConfig(db);
    await upsertCustomer(db, scope, { id: "hot" });
    await Promise.all(Array.from({ length: 100 }, () => track(db, scope, { customerId: "hot", featureId: "basic_message", value: "0.7" })));
    expect(await credits(scope, "hot")).toBe("30");
    expect(await ledgerDrift(db, scope)).toEqual([]);
  });

  test("parallel first requests for a new customer create it once, with one plan grant", async () => {
    const scope = await withExampleConfig(db);
    await Promise.all(Array.from({ length: 20 }, () => check(db, scope, { customerId: "new", featureId: "basic_message" })));
    const c = await getCustomer(db, scope, "new");
    expect(c.subscriptions).toHaveLength(1);
    expect(c.balances[0]!.breakdown).toHaveLength(1);
  });
});

describe("reservations (rule 8)", () => {
  test("lock, then confirm a smaller real amount: the rest comes back", async () => {
    const scope = await withExampleConfig(db);
    const exp = new Date(Date.now() + 60_000);
    const r = await check(db, scope, { customerId: "u", featureId: "basic_message", requiredBalance: "40", lock: { lockId: "c1", expiresAt: exp } });
    expect(r.allowed).toBe(true);
    expect(r.balances[0]!.balance).toBe("60");
    // A second lock cannot take more than what is left.
    expect((await check(db, scope, { customerId: "u", featureId: "basic_message", requiredBalance: "61" })).allowed).toBe(false);

    const done = await finalize(db, scope, { lockId: "c1", action: "confirm", overrideValue: "12.5" });
    expect(done.status).toBe("confirmed");
    expect(done.event?.value).toBe("12.5");
    expect(await credits(scope, "u")).toBe("87.5");
    // Confirming twice is a no-op.
    expect((await finalize(db, scope, { lockId: "c1", action: "confirm" })).event?.replayed).toBe(true);
    await expect(finalize(db, scope, { lockId: "c1", action: "release" })).rejects.toMatchObject({ code: "lock_finalized" });
    expect(await ledgerDrift(db, scope)).toEqual([]);
  });

  test("release returns everything; duplicate lock ids are refused", async () => {
    const scope = await withExampleConfig(db);
    const lock = { lockId: "c2", expiresAt: new Date(Date.now() + 60_000) };
    await check(db, scope, { customerId: "u", featureId: "premium_message", requiredBalance: "5", lock });
    await expect(check(db, scope, { customerId: "u", featureId: "premium_message", lock })).rejects.toMatchObject({ code: "lock_exists" });
    await finalize(db, scope, { lockId: "c2", action: "release" });
    expect(await credits(scope, "u")).toBe("100");
  });

  test("an expired lock is released and cannot be confirmed", async () => {
    const scope = await withExampleConfig(db);
    await check(db, scope, { customerId: "u", featureId: "basic_message", requiredBalance: "30", lock: { lockId: "c3", expiresAt: new Date(Date.now() + 200) } });
    expect(await credits(scope, "u")).toBe("70");
    await new Promise((r) => setTimeout(r, 300));
    expect(await credits(scope, "u")).toBe("100");
    await expect(finalize(db, scope, { lockId: "c3", action: "confirm" })).rejects.toMatchObject({ code: "lock_expired" });
    expect(await ledgerDrift(db, scope)).toEqual([]);
  });
});

describe("paid plan with overage (test env, skipPayment)", () => {
  test("paid plans need checkout unless skipPayment in test", async () => {
    const scope = await withExampleConfig(db);
    await expect(attach(db, scope, { customerId: "u", planId: "pro" })).rejects.toMatchObject({ code: "checkout_required" });
    await expect(attach(db, { ...scope, env: "live" }, { customerId: "u", planId: "pro", skipPayment: true })).rejects.toBeInstanceOf(NummoError);
  });

  test("upgrade replaces the free plan; overage accrues and stops at the 50 USDC cap", async () => {
    const scope = await withExampleConfig(db);
    await track(db, scope, { customerId: "u", featureId: "basic_message", value: "30" });
    const a = await attach(db, scope, { customerId: "u", planId: "pro", skipPayment: true });
    expect(a.replaced).toHaveLength(1);

    const c = await getCustomer(db, scope, "u");
    expect(c.subscriptions.map((s) => [s.planId, s.status])).toEqual([["pro", "active"], ["free", "ended"]]);
    expect(c.subscriptions[0]!.ceiling).toBe("70");
    expect(await credits(scope, "u")).toBe("1000");
    expect((await check(db, scope, { customerId: "u", featureId: "sso" })).allowed).toBe(true);

    // 1000 included, then 0.01 USDC per credit.
    await track(db, scope, { customerId: "u", featureId: "premium_message", value: "101" }); // 1010 credits
    const t = await track(db, scope, { customerId: "u", featureId: "premium_message", value: "1" });
    expect(t.overage).toEqual({ featureId: "credits", units: "10", amount: "0.1" });

    // The cap is 5000 overage credits; 20 used so far.
    const left = await check(db, scope, { customerId: "u", featureId: "premium_message", requiredBalance: "498" });
    expect(left.allowed).toBe(true);
    expect(left.overage).toEqual({ allowed: true, headroom: "4980" });
    expect((await check(db, scope, { customerId: "u", featureId: "premium_message", requiredBalance: "498.1" })).allowed).toBe(false);

    const capped = await track(db, scope, { customerId: "u", featureId: "premium_message", value: "600" });
    expect(capped.overage?.amount).toBe("49.8");
    expect(capped.unabsorbed).toBe("102");

    const acc = await db.execute(sql`select billable_units, amount from accruals where org_id = ${scope.orgId}`);
    expect(acc.rows).toEqual([{ billable_units: "5000.000000000", amount: String(usdc("50")) }]);
    expect(await ledgerDrift(db, scope)).toEqual([]);
  });

  test("past_due blocks overage (rule 6) but keeps the included balance", async () => {
    const scope = await withExampleConfig(db);
    const a = await attach(db, scope, { customerId: "u", planId: "pro", skipPayment: true });
    await db.execute(sql`update subscriptions set status = 'past_due' where id = ${a.subscriptionId}`);
    expect((await check(db, scope, { customerId: "u", featureId: "premium_message", requiredBalance: "100" })).allowed).toBe(true);
    expect((await check(db, scope, { customerId: "u", featureId: "premium_message", requiredBalance: "101" })).allowed).toBe(false);
  });

  test("an overage lock holds headroom against the cap until finalized", async () => {
    const scope = await withExampleConfig(db);
    await attach(db, scope, { customerId: "u", planId: "pro", skipPayment: true });
    await track(db, scope, { customerId: "u", featureId: "premium_message", value: "100" }); // included used up
    const lock = { lockId: "big", expiresAt: new Date(Date.now() + 60_000) };
    expect((await check(db, scope, { customerId: "u", featureId: "premium_message", requiredBalance: "400", lock })).allowed).toBe(true);
    expect((await check(db, scope, { customerId: "u", featureId: "premium_message", requiredBalance: "101" })).allowed).toBe(false);
    await finalize(db, scope, { lockId: "big", action: "confirm", overrideValue: "10" });
    const r = await check(db, scope, { customerId: "u", featureId: "premium_message", requiredBalance: "490" });
    expect(r.allowed).toBe(true);
    const acc = await db.execute(sql`select billable_units, held_units, amount from accruals where org_id = ${scope.orgId}`);
    expect(acc.rows).toEqual([{ billable_units: "100.000000000", held_units: "0.000000000", amount: String(usdc("1")) }]);
  });
});

describe("period resets (rule 9)", () => {
  test("after the period ends, leftovers expire and a fresh grant appears", async () => {
    const scope = await withExampleConfig(db);
    await track(db, scope, { customerId: "u", featureId: "basic_message", value: "60" });
    // Move the customer's anchor back by one period plus a day.
    await db.execute(sql`update subscriptions set period_anchor = period_anchor - interval '31 days' where org_id = ${scope.orgId}`);
    await db.execute(sql`update grants set expires_at = now() - interval '1 day', period_start = period_start - interval '31 days' where org_id = ${scope.orgId}`);
    const c = await getCustomer(db, scope, "u");
    expect(c.balances[0]!.balance).toBe("100");
    expect(c.balances[0]!.breakdown).toHaveLength(1);
    const expiry = await db.execute(sql`select delta from ledger_entries where org_id = ${scope.orgId} and reason = 'expiry'`);
    expect(expiry.rows).toEqual([{ delta: "-40.000000000" }]);
    expect(await ledgerDrift(db, scope)).toEqual([]);
  });
});

describe("manual grants and deduction order", () => {
  test("plan credits (resetting) are used before a never-expiring manual grant", async () => {
    const scope = await withExampleConfig(db);
    await grantBalance(db, scope, { customerId: "u", featureId: "credits", amount: "50" });
    await track(db, scope, { customerId: "u", featureId: "basic_message", value: "120" });
    const c = await getCustomer(db, scope, "u");
    const bd = c.balances[0]!.breakdown;
    expect(bd.find((b) => b.source === "plan")?.remaining).toBe("0");
    expect(bd.find((b) => b.source === "manual")?.remaining).toBe("30");
  });

  test("batch tracking across customers", async () => {
    const scope = await withExampleConfig(db);
    const rs = await trackBatch(db, scope, [
      { customerId: "a", featureId: "basic_message", value: "1" },
      { customerId: "b", featureId: "premium_message", value: "1" },
      { customerId: "a", featureId: "basic_message", value: "2" },
    ]);
    expect(rs.map((r) => r.customerId)).toEqual(["a", "b", "a"]);
    expect(await credits(scope, "a")).toBe("97");
    expect(await credits(scope, "b")).toBe("90");
  });
});

describe("config", () => {
  test("price changes need a new version; included amounts can change in place", async () => {
    const scope = await withExampleConfig(db);
    const doc = toDocument(exampleConfig);
    const pro = doc.plans.find((p) => p.id === "pro")!;
    pro.price = { amount: String(usdc("25")), periodHours: 720 };
    await expect(applyConfig(db, scope, doc)).rejects.toMatchObject({ code: "version_required" });

    const doc2 = toDocument(exampleConfig);
    doc2.plans.find((p) => p.id === "free")!.items[0]!.included = "200";
    const r = await applyConfig(db, scope, doc2);
    expect(r.changes.find((c) => c.id === "free@1")?.action).toBe("update");
    await expect(getCustomer(db, scope, "fresh")).rejects.toMatchObject({ code: "customer_not_found" });
    await upsertCustomer(db, scope, { id: "fresh" });
    expect(await credits(scope, "fresh")).toBe("200");
  });

  test("dry run reports changes without applying them", async () => {
    const scope = await withExampleConfig(db);
    const doc = toDocument(exampleConfig);
    doc.plans.push({ ...doc.plans[1]!, version: 2, price: { amount: String(usdc("25")), periodHours: 720 } });
    const r = await applyConfig(db, scope, doc, { dryRun: true });
    expect(r.changes.find((c) => c.id === "pro@2")?.action).toBe("create");
    const again = await applyConfig(db, scope, toDocument(exampleConfig), { dryRun: true });
    expect(again.changes.every((c) => c.action === "unchanged")).toBe(true);
  });
});
