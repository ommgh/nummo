ALTER TYPE "public"."invoice_kind" ADD VALUE 'pay_per_use';--> statement-breakpoint
ALTER TYPE "public"."invoice_line_kind" ADD VALUE 'pay_per_use';--> statement-breakpoint
CREATE TABLE "kv_store" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "env_settings" ADD COLUMN "pay_per_use" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "env_settings" ADD COLUMN "models" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "protocol" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "wallet" text;--> statement-breakpoint
CREATE INDEX "kv_store_expires_idx" ON "kv_store" USING btree ("expires_at");