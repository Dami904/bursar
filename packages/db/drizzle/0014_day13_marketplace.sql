ALTER TYPE "public"."payee_kind" ADD VALUE 'MARKETPLACE';--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "payee_source" text;--> statement-breakpoint
ALTER TABLE "payees" ADD COLUMN "filters" jsonb;