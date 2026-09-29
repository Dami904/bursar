CREATE TYPE "public"."gateway_withdrawal_state" AS ENUM('SUBMITTING', 'ATTESTED', 'DONE', 'FAILED');--> statement-breakpoint
CREATE TABLE "gateway_withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"fee" bigint,
	"recipient" text NOT NULL,
	"state" "gateway_withdrawal_state" DEFAULT 'SUBMITTING' NOT NULL,
	"burn_intent" jsonb NOT NULL,
	"intent_signature" text NOT NULL,
	"transfer_id" text,
	"attestation" text,
	"attestation_signature" text,
	"mint_tx" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_withdrawals_amount_positive" CHECK ("gateway_withdrawals"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "gateway_returned" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_withdrawals" ADD CONSTRAINT "gateway_withdrawals_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gateway_withdrawals_job_idx" ON "gateway_withdrawals" USING btree ("job_id","state");