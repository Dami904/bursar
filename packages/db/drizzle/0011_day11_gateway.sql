CREATE TYPE "public"."gateway_float_state" AS ENUM('RELEASING', 'FUNDED', 'DEPOSITING', 'CREDITING', 'ACTIVE', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."payment_rail" AS ENUM('VAULT', 'GATEWAY');--> statement-breakpoint
CREATE TABLE "gateway_floats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"state" "gateway_float_state" DEFAULT 'RELEASING' NOT NULL,
	"vault_op_id" text NOT NULL,
	"vault_tx" text,
	"vault_tx_nonce" integer,
	"vault_tx_sent_at" timestamp with time zone,
	"gas_tx" text,
	"approve_transfer_id" text,
	"deposit_transfer_id" text,
	"deposit_tx" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_floats_amount_positive" CHECK ("gateway_floats"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_counters_non_negative";--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_budget_invariant";--> statement-breakpoint
ALTER TABLE "authorizations" ADD COLUMN "rail" "payment_rail" DEFAULT 'VAULT' NOT NULL;--> statement-breakpoint
ALTER TABLE "authorizations" ADD COLUMN "gateway_transfer_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "gateway_funded" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "gateway_drawn" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_floats" ADD CONSTRAINT "gateway_floats_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gateway_floats_job_idx" ON "gateway_floats" USING btree ("job_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_floats_op_idx" ON "gateway_floats" USING btree ("vault_op_id");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_counters_non_negative" CHECK ("jobs"."deposited" >= 0 AND "jobs"."settled" >= 0 AND "jobs"."reserved" >= 0 AND "jobs"."pending" >= 0 AND "jobs"."unresolved" >= 0 AND "jobs"."window_spent" >= 0 AND "jobs"."gateway_funded" >= 0 AND "jobs"."gateway_drawn" >= 0);--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_budget_invariant" CHECK ("jobs"."settled" + "jobs"."reserved" + "jobs"."pending" + "jobs"."unresolved" + greatest("jobs"."gateway_funded" - "jobs"."gateway_drawn", 0) <= "jobs"."budget");