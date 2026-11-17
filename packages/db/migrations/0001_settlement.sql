CREATE TYPE "public"."attempt_status" AS ENUM('pending', 'confirmed', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."checkout_status" AS ENUM('open', 'submitted', 'completed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."invoice_kind" AS ENUM('activation', 'renewal', 'overage');--> statement-breakpoint
CREATE TYPE "public"."invoice_line_kind" AS ENUM('base', 'overage', 'writeoff');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('open', 'paid', 'void', 'uncollectible');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('confirmed', 'finalized', 'reverted');--> statement-breakpoint
CREATE TABLE "checkout_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"customer_id" text NOT NULL,
	"plan_version_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"status" "checkout_status" DEFAULT 'open' NOT NULL,
	"amount" bigint NOT NULL,
	"wallet" text,
	"message" text,
	"last_valid_block_height" bigint,
	"signature" text,
	"success_url" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"kind" "invoice_line_kind" NOT NULL,
	"feature_id" text,
	"quantity" numeric(38, 9),
	"amount" bigint NOT NULL,
	"accrual_id" text
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"customer_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"kind" "invoice_kind" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"total" bigint NOT NULL,
	"amount_paid" bigint DEFAULT 0 NOT NULL,
	"status" "invoice_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"customer_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"signature" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" "payment_status" DEFAULT 'confirmed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "settlement_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"subscription_id" text NOT NULL,
	"invoice_id" text,
	"checkout_session_id" text,
	"attempt" integer NOT NULL,
	"signature" text NOT NULL,
	"amount" bigint NOT NULL,
	"last_valid_block_height" bigint NOT NULL,
	"status" "attempt_status" DEFAULT 'pending' NOT NULL,
	"error_kind" text,
	"error_code" integer,
	"error" text,
	"onchain_period_start" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"env" "env" NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "outbox_pending_idx";--> statement-breakpoint
ALTER TABLE "accruals" ADD COLUMN "invoiced" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "dead_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD COLUMN "onchain_plan_id" text;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD COLUMN "onchain_owner" text;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD COLUMN "mint_address" text;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cancel_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "past_due_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "next_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "overage_blocked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "ended_reason" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkout_sessions_status_idx" ON "checkout_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_subscription_idx" ON "invoices" USING btree ("subscription_id","status");--> statement-breakpoint
CREATE INDEX "invoices_customer_idx" ON "invoices" USING btree ("org_id","env","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_period_uq" ON "invoices" USING btree ("subscription_id","period_start") WHERE kind in ('activation', 'renewal');--> statement-breakpoint
CREATE UNIQUE INDEX "payments_sig_uq" ON "payments" USING btree ("signature");--> statement-breakpoint
CREATE INDEX "payments_invoice_idx" ON "payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_attempts_sig_uq" ON "settlement_attempts" USING btree ("signature");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_attempts_pending_uq" ON "settlement_attempts" USING btree ("invoice_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "settlement_attempts_status_idx" ON "settlement_attempts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoints_scope_uq" ON "webhook_endpoints" USING btree ("org_id","env") WHERE disabled_at is null;--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("next_attempt_at") WHERE delivered_at is null and dead_at is null;