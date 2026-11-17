import { sql } from "drizzle-orm";
import { defineConfig, feature, plan, toDocument, usdc } from "@usenummo/config";
import { applyConfig, createDb, createOrg, runMigrations, type Db, type Scope } from "../src/index.ts";

let shared: ReturnType<typeof createDb> | null = null;
let migrated = false;

export async function testDb(): Promise<Db> {
  shared ??= createDb(process.env.DATABASE_URL ?? "postgres://nummo:nummo@localhost:5434/nummo");
  if (!migrated) {
    await runMigrations(shared.db);
    migrated = true;
  }
  return shared.db;
}

export async function closeTestDb() {
  await shared?.close();
  shared = null;
  migrated = false;
}

/** A fresh org per test keeps tests independent without truncating tables. */
export async function freshScope(db: Db): Promise<Scope> {
  return { orgId: await createOrg(db, "test"), env: "test" };
}

// The doc 04 example config.
const sso = feature({ id: "sso", type: "boolean" });
const basicMessage = feature({ id: "basic_message", type: "metered" });
const premiumMessage = feature({ id: "premium_message", type: "metered" });
const credits = feature({
  id: "credits",
  type: "credit_system",
  rates: [
    { feature: "basic_message", credits: 1 },
    { feature: "premium_message", credits: 10 },
  ],
});
export const exampleConfig = defineConfig({
  features: [sso, basicMessage, premiumMessage, credits],
  plans: [
    plan({ id: "free", version: 1, name: "Free", default: true, items: [{ feature: "credits", included: 100, reset: "30d" }] }),
    plan({
      id: "pro",
      version: 1,
      name: "Pro",
      price: { amount: usdc("20"), period: "30d" },
      items: [
        { feature: "sso" },
        { feature: "credits", included: 1000, reset: "period", overage: { price: usdc("0.01"), per: 1, cap: usdc("50") } },
      ],
    }),
  ],
});

export async function withExampleConfig(db: Db): Promise<Scope> {
  const scope = await freshScope(db);
  await applyConfig(db, scope, toDocument(exampleConfig));
  return scope;
}

/** Rule 2: every grant's remaining equals its amount plus the sum of its ledger entries. */
export async function ledgerDrift(db: Db, scope: Scope) {
  const r = await db.execute(sql`
    select g.id, g.amount, g.remaining, coalesce(sum(e.delta), 0) as entries
    from grants g left join ledger_entries e on e.grant_id = g.id
    where g.org_id = ${scope.orgId} and g.env = ${scope.env}
    group by g.id
    having g.remaining <> g.amount + coalesce(sum(e.delta), 0) or g.remaining < 0`);
  return r.rows;
}
