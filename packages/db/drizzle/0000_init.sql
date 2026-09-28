CREATE TYPE "public"."agent_status" AS ENUM('ACTIVE', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."authorization_state" AS ENUM('PENDING_APPROVAL', 'RESERVED', 'RELEASING', 'FUNDED_WALLET', 'SIGNING', 'UNRESOLVED', 'SETTLED', 'RELEASED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."decision_kind" AS ENUM('PURCHASE', 'INVOICE');--> statement-breakpoint
CREATE TYPE "public"."decision_result" AS ENUM('ALLOWED', 'DENIED', 'NEEDS_APPROVAL');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('DRAFT', 'PENDING_CHAIN', 'ACTIVE', 'PAUSED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."payee_kind" AS ENUM('X402_ORIGIN', 'ADDRESS');--> statement-breakpoint
CREATE TYPE "public"."credential_role" AS ENUM('OWNER', 'APPROVER', 'AGENT');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"parent_agent_id" uuid,
	"replaces_agent_id" uuid,
	"status" "agent_status" DEFAULT 'ACTIVE' NOT NULL,
	"spend_limit" bigint,
	"committed" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agents_committed_within_limit" CHECK ("agents"."committed" >= 0 AND ("agents"."spend_limit" IS NULL OR "agents"."committed" <= "agents"."spend_limit"))
);
--> statement-breakpoint
CREATE TABLE "authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"category" text,
	"state" "authorization_state" NOT NULL,
	"payer" text,
	"pay_to" text,
	"payment_nonce" text,
	"valid_before" timestamp with time zone,
	"vault_tx" text,
	"payment_tx" text,
	"resolved_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authorizations_amount_positive" CHECK ("authorizations"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "category_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"category" text NOT NULL,
	"spend_limit" bigint NOT NULL,
	"committed" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "category_committed_within_limit" CHECK ("category_limits"."committed" >= 0 AND "category_limits"."committed" <= "category_limits"."spend_limit")
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"role" "credential_role" NOT NULL,
	"owner_id" uuid NOT NULL,
	"job_id" uuid,
	"agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "credentials_agent_scope" CHECK (("credentials"."role" = 'AGENT') = ("credentials"."job_id" IS NOT NULL AND "credentials"."agent_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"kind" "decision_kind" NOT NULL,
	"payee" text NOT NULL,
	"amount" bigint NOT NULL,
	"category" text,
	"reasoning" text NOT NULL,
	"result" "decision_result" NOT NULL,
	"reason" text,
	"checks" jsonb NOT NULL,
	"remaining_at_decision" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"customer" text NOT NULL,
	"status" "job_status" DEFAULT 'DRAFT' NOT NULL,
	"budget" bigint NOT NULL,
	"deposited" bigint DEFAULT 0 NOT NULL,
	"settled" bigint DEFAULT 0 NOT NULL,
	"reserved" bigint DEFAULT 0 NOT NULL,
	"pending" bigint DEFAULT 0 NOT NULL,
	"unresolved" bigint DEFAULT 0 NOT NULL,
	"per_tx_cap" bigint NOT NULL,
	"approval_threshold" bigint NOT NULL,
	"window_cap" bigint NOT NULL,
	"window_seconds" integer DEFAULT 3600 NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"window_spent" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"delegation_allowed" boolean DEFAULT true NOT NULL,
	"vault_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_counters_non_negative" CHECK ("jobs"."deposited" >= 0 AND "jobs"."settled" >= 0 AND "jobs"."reserved" >= 0 AND "jobs"."pending" >= 0 AND "jobs"."unresolved" >= 0 AND "jobs"."window_spent" >= 0),
	CONSTRAINT "jobs_budget_invariant" CHECK ("jobs"."settled" + "jobs"."reserved" + "jobs"."pending" + "jobs"."unresolved" <= "jobs"."budget"),
	CONSTRAINT "jobs_limits_positive" CHECK ("jobs"."budget" > 0 AND "jobs"."per_tx_cap" > 0 AND "jobs"."window_cap" > 0 AND "jobs"."window_seconds" > 0 AND "jobs"."approval_threshold" >= 0)
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"wallet_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" "payee_kind" NOT NULL,
	"value" text NOT NULL,
	"label" text,
	"category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_parent_agent_id_agents_id_fk" FOREIGN KEY ("parent_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_replaces_agent_id_agents_id_fk" FOREIGN KEY ("replaces_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_limits" ADD CONSTRAINT "category_limits_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payees" ADD CONSTRAINT "payees_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_job_idx" ON "agents" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "agents_parent_idx" ON "agents" USING btree ("parent_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "authorizations_decision_idx" ON "authorizations" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "authorizations_job_state_idx" ON "authorizations" USING btree ("job_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "category_limits_job_category_idx" ON "category_limits" USING btree ("job_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_key_hash_idx" ON "credentials" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_job_operation_idx" ON "decisions" USING btree ("job_id","operation_id");--> statement-breakpoint
CREATE INDEX "decisions_job_created_idx" ON "decisions" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_owner_idx" ON "jobs" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payees_job_value_idx" ON "payees" USING btree ("job_id","kind","value");