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
export const checkoutStatusEnum = pgEnum("checkout_status", ["open", "submitted", "completed", "expired"]);
/** subscribe: first paid plan. change: an immediate upgrade from another paid plan. topup: a one-off purchase. */
export const checkoutKindEnum = pgEnum("checkout_kind", ["subscribe", "change", "topup"]);
export const invoiceKindEnum = pgEnum("invoice_kind", ["activation", "renewal", "overage", "topup"]);
export const invoiceStatusEnum = pgEnum("invoice_status", ["open", "paid", "void", "uncollectible"]);
export const invoiceLineKindEnum = pgEnum("invoice_line_kind", ["base", "overage", "writeoff", "proration", "topup"]);
export const attemptStatusEnum = pgEnum("attempt_status", ["pending", "confirmed", "failed", "expired"]);
export const paymentStatusEnum = pgEnum("payment_status", ["confirmed", "finalized", "reverted"]);

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
    /** The u64 plan id the PDA is derived from, as a decimal string. */
    onchainPlanId: text("onchain_plan_id"),
    /** The merchant wallet that owns the on-chain plan and receives funds. */
    onchainOwner: text("onchain_owner"),
    /** The token mint address the on-chain plan charges in. */
    mintAddress: text("mint_address"),
    publishedAt: ts("published_at"),
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
    /** Automatic top-up (doc 04): below this balance, pull `auto_topup_price` and grant `auto_topup_quantity`. */
    autoTopUpBelow: qty("auto_topup_below"),
    autoTopUpQuantity: qty("auto_topup_quantity"),
    autoTopUpPrice: money("auto_topup_price"),
    autoTopUpMaxPerPeriod: integer("auto_topup_max_per_period"),
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
    /** When a cancellation signed on-chain takes effect (the record's expires_at). */
    cancelAt: ts("cancel_at"),
    /** Failed-payment state machine (doc 03, "When a pull fails"). */
    pastDueSince: ts("past_due_since"),
    retryCount: integer("retry_count").notNull().default(0),
    nextRetryAt: ts("next_retry_at"),
    /** Set when a pull was cut to what the on-chain ceiling had left; overage stops until then. */
    overageBlockedUntil: ts("overage_blocked_until"),
    /**
     * Set when an immediate plan change replaced this subscription. Its
     * entitlements stopped then; it stays `canceling` until the on-chain record
     * ends, so overage already used can still be collected.
     */
    replacedBy: text("replaced_by"),
    /** A downgrade waiting for the period end: the plan version to move to, and when. */
    scheduledPlanVersionId: text("scheduled_plan_version_id"),
    scheduledAt: ts("scheduled_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    endedAt: ts("ended_at"),
    endedReason: text("ended_reason"),
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
    /** Amount already moved onto an invoice. amount - invoiced is still to bill. */
    invoiced: money("invoiced").notNull().default(sql`0`),
    /** billable_units already moved onto an invoice, so each line shows the units it bills. */
    invoicedUnits: qty("invoiced_units").notNull().default(sql`0`),
    /** Amount collected on-chain. */
    collected: money("collected").notNull().default(sql`0`),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("accruals_uq").on(t.subscriptionId, t.periodStart, t.featureId)],
);

// ------------------------------------------------------------------ money

/** A hosted checkout: the customer connects a wallet and signs the activation once (doc 03). */
export const checkoutSessions = pgTable(
  "checkout_sessions",
  {
    id: text("id").primaryKey(),
    ...scope,
    customerId: text("customer_id").notNull(),
    kind: checkoutKindEnum("kind").notNull().default("subscribe"),
    /** subscribe and change: the plan version being activated. */
    planVersionId: text("plan_version_id").references(() => planVersions.id),
    /** subscribe and change: the pending subscription this checkout activates. */
    subscriptionId: text("subscription_id"),
    /** change: the paid subscription being replaced. Its wallet must sign. */
    replacesSubscriptionId: text("replaces_subscription_id"),
    /** change: the credit for the unused part of the old period, { credit, periodStart, periodEnd }. */
    proration: jsonb("proration"),
    /** topup: what is bought, and where the payment goes. */
    featureId: text("feature_id"),
    quantity: qty("quantity"),
    payTo: text("pay_to"),
    /** topup: a random public key added to the transfer, so the payment can be found (the Solana Pay convention). */
    reference: text("reference"),
    status: checkoutStatusEnum("status").notNull().default("open"),
    /** What the customer pays in this transaction: the base fee, the prorated difference, or the top-up price. */
    amount: money("amount").notNull(),
    wallet: text("wallet"),
    /** The transaction message we built, base64. The signed copy must match it byte for byte. */
    message: text("message"),
    lastValidBlockHeight: bigint("last_valid_block_height", { mode: "bigint" }),
    signature: text("signature"),
    successUrl: text("success_url"),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    completedAt: ts("completed_at"),
  },
  (t) => [index("checkout_sessions_status_idx").on(t.status)],
);

export const invoices = pgTable(
  "invoices",
  {
    id: text("id").primaryKey(),
    ...scope,
    customerId: text("customer_id").notNull(),
    /** Null for a one-off top-up. */
    subscriptionId: text("subscription_id"),
    kind: invoiceKindEnum("kind").notNull(),
    /** The billing period the invoice belongs to. */
    periodStart: ts("period_start").notNull(),
    total: money("total").notNull(),
    amountPaid: money("amount_paid").notNull().default(sql`0`),
    status: invoiceStatusEnum("status").notNull().default("open"),
    createdAt: ts("created_at").notNull().defaultNow(),
    paidAt: ts("paid_at"),
  },
  (t) => [
    index("invoices_subscription_idx").on(t.subscriptionId, t.status),
    index("invoices_customer_idx").on(t.orgId, t.env, t.customerId),
    // One base-fee invoice per subscription and period, even if two workers race.
    uniqueIndex("invoices_period_uq").on(t.subscriptionId, t.periodStart).where(sql`kind in ('activation', 'renewal')`),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    kind: invoiceLineKindEnum("kind").notNull(),
    featureId: text("feature_id"),
    quantity: qty("quantity"),
    /** Signed: a write-off line is negative. */
    amount: money("amount").notNull(),
    accrualId: text("accrual_id"),
  },
  (t) => [index("invoice_lines_invoice_idx").on(t.invoiceId)],
);

/**
 * Every transaction we sign that moves money: the activation and each pull.
 * Recorded before it is broadcast, so a resend can be ruled out (doc 03,
 * "Sending transactions safely").
 */
export const settlementAttempts = pgTable(
  "settlement_attempts",
  {
    id: text("id").primaryKey(),
    ...scope,
    /** Null for a one-off top-up. */
    subscriptionId: text("subscription_id"),
    invoiceId: text("invoice_id"),
    checkoutSessionId: text("checkout_session_id"),
    attempt: integer("attempt").notNull(),
    signature: text("signature").notNull(),
    amount: money("amount").notNull(),
    lastValidBlockHeight: bigint("last_valid_block_height", { mode: "bigint" }).notNull(),
    status: attemptStatusEnum("status").notNull().default("pending"),
    errorKind: text("error_kind"),
    errorCode: integer("error_code"),
    error: text("error"),
    /** The on-chain period the pull counted against, read back after confirmation. */
    onchainPeriodStart: ts("onchain_period_start"),
    createdAt: ts("created_at").notNull().defaultNow(),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [
    uniqueIndex("settlement_attempts_sig_uq").on(t.signature),
    // Never two unresolved transactions for one invoice: that is how a customer gets charged twice.
    uniqueIndex("settlement_attempts_pending_uq").on(t.invoiceId).where(sql`status = 'pending'`),
    index("settlement_attempts_status_idx").on(t.status),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    ...scope,
    customerId: text("customer_id").notNull(),
    /** Null for a one-off top-up. */
    subscriptionId: text("subscription_id"),
    invoiceId: text("invoice_id").notNull(),
    signature: text("signature").notNull(),
    amount: money("amount").notNull(),
    status: paymentStatusEnum("status").notNull().default("confirmed"),
    createdAt: ts("created_at").notNull().defaultNow(),
    finalizedAt: ts("finalized_at"),
  },
  (t) => [uniqueIndex("payments_sig_uq").on(t.signature), index("payments_invoice_idx").on(t.invoiceId)],
);

/** Per-environment settings that come from the pricing config but are not plans or features. */
export const envSettings = pgTable(
  "env_settings",
  {
    ...scope,
    /** Merchant wallet for one-off top-ups. Null: the owner of the latest published plan. */
    payTo: text("pay_to"),
    /** TopUpDoc[] from the config: which features can be bought, and at what price. */
    topUps: jsonb("top_ups").notNull().default(sql`'[]'::jsonb`),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.env] })],
);

/**
 * A customer portal link (doc 04, "Customer portal"). Like a checkout, the long
 * random id is the only credential. `pending` holds the transaction the
 * customer's wallet is asked to sign (cancel or resume), so the signed copy can
 * be checked byte for byte.
 */
export const portalSessions = pgTable(
  "portal_sessions",
  {
    id: text("id").primaryKey(),
    ...scope,
    customerId: text("customer_id").notNull(),
    returnUrl: text("return_url"),
    pending: jsonb("pending"),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index("portal_sessions_customer_idx").on(t.orgId, t.env, t.customerId)],
);

/** Merchant dashboard sign-ins. The cookie holds a random token; we store its hash. */

// ------------------------------------------------------------------ webhooks

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey(),
    ...scope,
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    disabledAt: ts("disabled_at"),
  },
  (t) => [uniqueIndex("webhook_endpoints_scope_uq").on(t.orgId, t.env).where(sql`disabled_at is null`)],
);

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
    lastError: text("last_error"),
    /** Set when delivery gave up after the last retry. */
    deadAt: ts("dead_at"),
  },
  (t) => [index("outbox_pending_idx").on(t.nextAttemptAt).where(sql`delivered_at is null and dead_at is null`)],
);

// ------------------------------------------------------------------ dashboard accounts (Better Auth)
//
// Users, their sessions and sign-in methods, and organizations with members and
// invitations: the tables Better Auth's Drizzle adapter and organization plugin
// expect (generated with `npx auth generate`), under auth_ names. An
// organization's id is the nummo org id (apps/api/src/auth.ts).

export const authUsers = pgTable("auth_users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: ts("created_at").defaultNow().notNull(),
  updatedAt: ts("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at").$onUpdate(() => new Date()).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId)],
);

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at").$onUpdate(() => new Date()).notNull(),
  },
  (t) => [index("auth_accounts_user_idx").on(t.userId)],
);

export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").defaultNow().notNull(),
    updatedAt: ts("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (t) => [index("auth_verifications_identifier_idx").on(t.identifier)],
);

export const authOrganizations = pgTable("auth_organizations", {
  /** The nummo org id (orgs.id). */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: ts("created_at").notNull(),
  metadata: text("metadata"),
});

export const authMembers = pgTable(
  "auth_members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => authOrganizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    role: text("role").default("member").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("auth_members_org_idx").on(t.organizationId), index("auth_members_user_idx").on(t.userId)],
);

export const authInvitations = pgTable(
  "auth_invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => authOrganizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").defaultNow().notNull(),
    inviterId: text("inviter_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  },
  (t) => [index("auth_invitations_org_idx").on(t.organizationId), index("auth_invitations_email_idx").on(t.email)],
);
