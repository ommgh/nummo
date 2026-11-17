CREATE TYPE "public"."env" AS ENUM('test', 'live');--> statement-breakpoint
CREATE TYPE "public"."feature_type" AS ENUM('boolean', 'metered', 'credit_system');--> statement-breakpoint
CREATE TYPE "public"."grant_source" AS ENUM('plan', 'topup', 'manual', 'reward');--> statement-breakpoint
CREATE TYPE "public"."ledger_reason" AS ENUM('grant', 'usage', 'expiry', 'reset', 'adjustment', 'lock', 'release');--> statement-breakpoint
CREATE TYPE "public"."lock_status" AS ENUM('held', 'confirmed', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."plan_version_status" AS ENUM('draft', 'active', 'sunset');--> statement-breakpoint
CREATE TYPE "public"."reset_kind" AS ENUM('period', 'every', 'never');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('pending', 'active', 'past_due', 'canceling', 'ended');--> statement-breakpoint
CREATE TABLE "accruals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"subscription_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"feature_id" text NOT NULL,
	"billable_units" numeric(38, 9) DEFAULT 0 NOT NULL,
	"held_units" numeric(38, 9) DEFAULT 0 NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"collected" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credit_rates" (
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"metered_feature_id" text NOT NULL,
	"credit_feature_id" text NOT NULL,
	"credits_per_unit" numeric(38, 9) NOT NULL,
	CONSTRAINT "credit_rates_org_id_env_metered_feature_id_pk" PRIMARY KEY("org_id","env","metered_feature_id")
);
--> statement-breakpoint
CREATE TABLE "customer_wallets" (
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"customer_id" text NOT NULL,
	"address" text NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "customer_wallets_org_id_env_customer_id_address_pk" PRIMARY KEY("org_id","env","customer_id","address")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"id" text NOT NULL,
	"name" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_org_id_env_id_pk" PRIMARY KEY("org_id","env","id")
);
--> statement-breakpoint
CREATE TABLE "features" (
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"id" text NOT NULL,
	"name" text,
	"type" "feature_type" NOT NULL,
	"consumable" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "features_org_id_env_id_pk" PRIMARY KEY("org_id","env","id")
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"customer_id" text NOT NULL,
	"feature_id" text NOT NULL,
	"source" "grant_source" NOT NULL,
	"amount" numeric(38, 9) NOT NULL,
	"remaining" numeric(38, 9) NOT NULL,
	"reset_hours" integer,
	"expires_at" timestamp with time zone,
	"subscription_id" text,
	"period_start" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"customer_id" text NOT NULL,
	"feature_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"delta" numeric(38, 9) NOT NULL,
	"reason" "ledger_reason" NOT NULL,
	"usage_event_id" text,
	"lock_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locks" (
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"lock_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"feature_id" text NOT NULL,
	"held" numeric(38, 9) NOT NULL,
	"allocations" jsonb NOT NULL,
	"overage" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "lock_status" DEFAULT 'held' NOT NULL,
	"usage_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "locks_org_id_env_lock_id_pk" PRIMARY KEY("org_id","env","lock_id")
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_items" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_version_id" text NOT NULL,
	"feature_id" text NOT NULL,
	"included" numeric(38, 9),
	"reset_kind" "reset_kind" NOT NULL,
	"reset_hours" integer,
	"overage_price" bigint,
	"overage_per" numeric(38, 9),
	"overage_cap" bigint
);
--> statement-breakpoint
CREATE TABLE "plan_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"plan_id" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"base_amount" bigint DEFAULT 0 NOT NULL,
	"period_hours" integer,
	"ceiling_amount" bigint,
	"mint" text DEFAULT 'USDC' NOT NULL,
	"onchain_plan_pda" text,
	"status" "plan_version_status" DEFAULT 'active' NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"is_addon" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_org_id_env_id_pk" PRIMARY KEY("org_id","env","id")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"customer_id" text NOT NULL,
	"plan_version_id" text NOT NULL,
	"status" "subscription_status" NOT NULL,
	"period_anchor" timestamp with time zone NOT NULL,
	"wallet" text,
	"subscription_pda" text,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"customer_id" text NOT NULL,
	"feature_id" text NOT NULL,
	"value" numeric(38, 9) NOT NULL,
	"properties" jsonb,
	"idempotency_key" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accruals_uq" ON "accruals" USING btree ("subscription_id","period_start","feature_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "grants_customer_idx" ON "grants" USING btree ("org_id","env","customer_id","feature_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grants_plan_period_uq" ON "grants" USING btree ("subscription_id","feature_id",coalesce("period_start", 'epoch'::timestamptz)) WHERE source = 'plan';--> statement-breakpoint
CREATE INDEX "ledger_entries_grant_idx" ON "ledger_entries" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "locks_customer_idx" ON "locks" USING btree ("org_id","env","customer_id","status");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("next_attempt_at") WHERE delivered_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_items_uq" ON "plan_items" USING btree ("plan_version_id","feature_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_versions_uq" ON "plan_versions" USING btree ("org_id","env","plan_id","version");--> statement-breakpoint
CREATE INDEX "subscriptions_customer_idx" ON "subscriptions" USING btree ("org_id","env","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_idem_uq" ON "usage_events" USING btree ("org_id","env","customer_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "usage_events_customer_idx" ON "usage_events" USING btree ("org_id","env","customer_id","occurred_at");