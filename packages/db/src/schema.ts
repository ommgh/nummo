/**
 * Database schema, following the data model in docs/02-architecture.md.
 *
 * Every merchant-owned row carries `org_id` and `env` (`test` for devnet,
 * `live` for mainnet). Money is bigint base units. Feature quantities are
 * numeric(38, 9), which maps exactly onto the core's Qty (bigint scaled 10^9).
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const envEnum = pgEnum("env", ["test", "live"]);
export const featureTypeEnum = pgEnum("feature_type", ["boolean", "metered", "credit_system"]);
export const planVersionStatusEnum = pgEnum("plan_version_status", ["draft", "active", "sunset"]);
export const resetKindEnum = pgEnum("reset_kind", ["period", "every", "never"]);
export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "pending",
  "active",
  "past_due",
  "canceling",
  "ended",
]);
export const grantSourceEnum = pgEnum("grant_source", ["plan", "topup", "manual", "reward"]);
export const ledgerReasonEnum = pgEnum("ledger_reason", [
  "grant",
  "usage",
  "expiry",
  "reset",
  "adjustment",
  "lock",
  "release",
]);
export const lockStatusEnum = pgEnum("lock_status", ["held", "confirmed", "released", "expired"]);

const qty = (name: string) => numeric(name, { precision: 38, scale: 9 });
const money = (name: string) => bigint(name, { mode: "bigint" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const scope = {
  orgId: text("org_id").notNull(),
  env: envEnum("env").notNull(),
};

// ------------------------------------------------------------------ tenancy

export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    ...scope,
    /** SHA-256 of the secret key, hex. The key itself is never stored. */
    keyHash: text("key_hash").notNull(),
    /** First characters of the key, for display ("nummo_sk_test_ab12…"). */
    prefix: text("prefix").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [uniqueIndex("api_keys_hash_uq").on(t.keyHash)],
);

// ------------------------------------------------------------------ config

export const features = pgTable(
  "features",
  {
    ...scope,
    id: text("id").notNull(),
    name: text("name"),
    type: featureTypeEnum("type").notNull(),
    consumable: boolean("consumable").notNull().default(true),
    archivedAt: ts("archived_at"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.env, t.id] })],
);

export const creditRates = pgTable(
  "credit_rates",
  {
    ...scope,
    meteredFeatureId: text("metered_feature_id").notNull(),
    creditFeatureId: text("credit_feature_id").notNull(),
    creditsPerUnit: qty("credits_per_unit").notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.env, t.meteredFeatureId] })],
);

export const plans = pgTable(
  "plans",
  {
    ...scope,
    id: text("id").notNull(),
    name: text("name").notNull(),
    isAddon: boolean("is_addon").notNull().default(false),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.env, t.id] })],
);

export const planVersions = pgTable(
  "plan_versions",
  {
    id: text("id").primaryKey(),
    ...scope,
    planId: text("plan_id").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    baseAmount: money("base_amount").notNull().default(sql`0`),
    /** Null for free plans. */
    periodHours: integer("period_hours"),
    /** The on-chain plan amount: base plus overage caps (decision D3). Null if nothing goes on-chain. */
    ceilingAmount: money("ceiling_amount"),
    mint: text("mint").notNull().default("USDC"),
    onchainPlanPda: text("onchain_plan_pda"),
    status: planVersionStatusEnum("status").notNull().default("active"),
    /** The plan document as last applied, for diffs in `nummo push`. */
    document: jsonb("document").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("plan_versions_uq").on(t.orgId, t.env, t.planId, t.version)],
);

export const planItems = pgTable(
  "plan_items",
  {
    id: text("id").primaryKey(),
    planVersionId: text("plan_version_id")
      .notNull()
      .references(() => planVersions.id, { onDelete: "cascade" }),
    featureId: text("feature_id").notNull(),
    included: qty("included"),
    resetKind: resetKindEnum("reset_kind").notNull(),
    /** Hours between resets when reset_kind = 'every'. */
    resetHours: integer("reset_hours"),
    overagePrice: money("overage_price"),
    overagePer: qty("overage_per"),
    overageCap: money("overage_cap"),
  },
  (t) => [uniqueIndex("plan_items_uq").on(t.planVersionId, t.featureId)],
);

// ------------------------------------------------------------------ customers and subscriptions

export const customers = pgTable(
  "customers",
  {
    ...scope,
    /** The merchant's own user id. */
    id: text("id").notNull(),
    name: text("name"),
    email: text("email"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.env, t.id] })],
);

export const customerWallets = pgTable(
  "customer_wallets",
  {
    ...scope,
    customerId: text("customer_id").notNull(),
    address: text("address").notNull(),
    verifiedAt: ts("verified_at"),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.env, t.customerId, t.address] })],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    ...scope,
    customerId: text("customer_id").notNull(),
    planVersionId: text("plan_version_id")
      .notNull()
      .references(() => planVersions.id),
    status: subscriptionStatusEnum("status").notNull(),
    /** Periods are anchor + k * period (doc 03). On-chain period start for paid plans, attach time for free ones. */
    periodAnchor: ts("period_anchor").notNull(),
    wallet: text("wallet"),
    subscriptionPda: text("subscription_pda"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    endedAt: ts("ended_at"),
  },
  (t) => [index("subscriptions_customer_idx").on(t.orgId, t.env, t.customerId)],
);

// ------------------------------------------------------------------ ledger

export const grants = pgTable(
  "grants",
  {
    id: text("id").primaryKey(),
    ...scope,
    customerId: text("customer_id").notNull(),
    featureId: text("feature_id").notNull(),
    source: grantSourceEnum("source").notNull(),
    amount: qty("amount").notNull(),
    /** Cached: amount + sum(ledger_entries.delta) for this grant (rule 2). */
    remaining: qty("remaining").notNull(),
    resetHours: integer("reset_hours"),
    expiresAt: ts("expires_at"),
    subscriptionId: text("subscription_id"),
    periodStart: ts("period_start"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("grants_customer_idx").on(t.orgId, t.env, t.customerId, t.featureId),
    // One plan grant per subscription, feature and period, even under concurrency.
    // coalesce so that never-resetting grants (null period_start) are unique too.
    uniqueIndex("grants_plan_period_uq")
      .on(t.subscriptionId, t.featureId, sql`coalesce(${t.periodStart}, 'epoch'::timestamptz)`)
      .where(sql`source = 'plan'`),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: text("id").primaryKey(),
    ...scope,
    customerId: text("customer_id").notNull(),
    featureId: text("feature_id").notNull(),
    value: qty("value").notNull(),
    properties: jsonb("properties"),
    idempotencyKey: text("idempotency_key"),
    occurredAt: ts("occurred_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    /** The response returned the first time, replayed for a duplicate idempotency key (rule 7). */
    result: jsonb("result").notNull(),
  },
  (t) => [
    uniqueIndex("usage_events_idem_uq").on(t.orgId, t.env, t.customerId, t.idempotencyKey),
    index("usage_events_customer_idx").on(t.orgId, t.env, t.customerId, t.occurredAt),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    ...scope,
    customerId: text("customer_id").notNull(),
    featureId: text("feature_id").notNull(),
    grantId: text("grant_id").notNull(),
    delta: qty("delta").notNull(),
    reason: ledgerReasonEnum("reason").notNull(),
    usageEventId: text("usage_event_id"),
    lockId: text("lock_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("ledger_entries_grant_idx").on(t.grantId)],
);

export const locks = pgTable(
  "locks",
  {
    ...scope,
    lockId: text("lock_id").notNull(),
    customerId: text("customer_id").notNull(),
    featureId: text("feature_id").notNull(),
    held: qty("held").notNull(),
    /** Core Allocation[] taken from grants, with amounts as decimal strings. */
    allocations: jsonb("allocations").notNull(),
    /** Overage units held against the cap: { subscriptionId, periodStart, featureId, units }. */
    overage: jsonb("overage"),
    expiresAt: ts("expires_at").notNull(),
    status: lockStatusEnum("status").notNull().default("held"),
    usageEventId: text("usage_event_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    finalizedAt: ts("finalized_at"),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.env, t.lockId] }),
    index("locks_customer_idx").on(t.orgId, t.env, t.customerId, t.status),
  ],
);

/** Overage owed but not yet collected, per subscription, billing period and feature. */
export const accruals = pgTable(
  "accruals",
  {
    id: text("id").primaryKey(),
    ...scope,
    subscriptionId: text("subscription_id").notNull(),
    periodStart: ts("period_start").notNull(),
    featureId: text("feature_id").notNull(),
    billableUnits: qty("billable_units").notNull().default(sql`0`),
    /** Units reserved by open locks; they count against the cap but are not billed. */
    heldUnits: qty("held_units").notNull().default(sql`0`),
    /** overageCost(billable_units), in base units. */
    amount: money("amount").notNull().default(sql`0`),
    /** Amount already collected on-chain (milestone M2). */
    collected: money("collected").notNull().default(sql`0`),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("accruals_uq").on(t.subscriptionId, t.periodStart, t.featureId)],
);

// ------------------------------------------------------------------ webhooks

export const outbox = pgTable(
  "outbox",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    ...scope,
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    deliveredAt: ts("delivered_at"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
  },
  (t) => [index("outbox_pending_idx").on(t.nextAttemptAt).where(sql`delivered_at is null`)],
);
