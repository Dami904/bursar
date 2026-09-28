CREATE TABLE "chain_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"event_name" text NOT NULL,
	"vault_job_id" text,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authorizations" ADD COLUMN "vault_op_id" text;--> statement-breakpoint
ALTER TABLE "authorizations" ADD COLUMN "payment_url" text;--> statement-breakpoint
ALTER TABLE "authorizations" ADD COLUMN "payment_requirements" jsonb;--> statement-breakpoint
ALTER TABLE "authorizations" ADD COLUMN "deliverable" text;--> statement-breakpoint
ALTER TABLE "authorizations" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "authorizations" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "authorizations" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "policy_version" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "agent_wallet_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "agent_wallet_address" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "policy_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "chain_events_tx_log_idx" ON "chain_events" USING btree ("tx_hash","log_index");--> statement-breakpoint
CREATE INDEX "authorizations_work_idx" ON "authorizations" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_vault_job_idx" ON "jobs" USING btree ("vault_job_id");