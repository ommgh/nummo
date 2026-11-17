CREATE TYPE "public"."checkout_kind" AS ENUM('subscribe', 'change', 'topup');--> statement-breakpoint
ALTER TYPE "public"."invoice_kind" ADD VALUE 'topup';--> statement-breakpoint
ALTER TYPE "public"."invoice_line_kind" ADD VALUE 'proration';--> statement-breakpoint
ALTER TYPE "public"."invoice_line_kind" ADD VALUE 'topup';--> statement-breakpoint
CREATE TABLE "dashboard_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"api_key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "env_settings" (
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"pay_to" text,
	"top_ups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "env_settings_org_id_env_pk" PRIMARY KEY("org_id","env")
);
--> statement-breakpoint
CREATE TABLE "portal_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"customer_id" text NOT NULL,
	"return_url" text,
	"pending" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checkout_sessions" ALTER COLUMN "plan_version_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ALTER COLUMN "subscription_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "subscription_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "subscription_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement_attempts" ALTER COLUMN "subscription_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "kind" "checkout_kind" DEFAULT 'subscribe' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "replaces_subscription_id" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "proration" jsonb;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "feature_id" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "quantity" numeric(38, 9);--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "pay_to" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "reference" text;--> statement-breakpoint
ALTER TABLE "plan_items" ADD COLUMN "auto_topup_below" numeric(38, 9);--> statement-breakpoint
ALTER TABLE "plan_items" ADD COLUMN "auto_topup_quantity" numeric(38, 9);--> statement-breakpoint
ALTER TABLE "plan_items" ADD COLUMN "auto_topup_price" bigint;--> statement-breakpoint
ALTER TABLE "plan_items" ADD COLUMN "auto_topup_max_per_period" integer;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "replaced_by" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "scheduled_plan_version_id" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "scheduled_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "portal_sessions_customer_idx" ON "portal_sessions" USING btree ("org_id","env","customer_id");