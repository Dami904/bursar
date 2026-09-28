ALTER TABLE "jobs" ADD COLUMN "brief" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "operator_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "operator_revenue_seen" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "autopilot_agent_id" uuid;