CREATE TYPE "public"."anchor_status" AS ENUM('SENT', 'CONFIRMED', 'FAILED');--> statement-breakpoint
CREATE TABLE "audit_anchors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"anchor_seq" integer NOT NULL,
	"chain_seq" bigint NOT NULL,
	"head" text NOT NULL,
	"status" "anchor_status" NOT NULL,
	"tx_hash" text,
	"error" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_chain" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"job_id" uuid,
	"event" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "replaced_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "invoice_ref" text;--> statement-breakpoint
ALTER TABLE "audit_chain" ADD CONSTRAINT "audit_chain_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_anchors_confirmed_seq_idx" ON "audit_anchors" USING btree ("anchor_seq") WHERE "audit_anchors"."status" = 'CONFIRMED';--> statement-breakpoint
CREATE INDEX "audit_chain_job_idx" ON "audit_chain" USING btree ("job_id","seq");--> statement-breakpoint
CREATE INDEX "audit_chain_ref_idx" ON "audit_chain" USING btree ("ref_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_replaced_by_agent_id_agents_id_fk" FOREIGN KEY ("replaced_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- An agent's committed total now covers its whole subtree (its helpers' spending counts against
-- its limit too). Recompute it from the authorizations that still hold money.
WITH RECURSIVE tree(ancestor_id, agent_id) AS (
  SELECT id, id FROM agents
  UNION ALL
  SELECT t.ancestor_id, a.id FROM agents a JOIN tree t ON a.parent_agent_id = t.agent_id
)
UPDATE agents SET committed = coalesce((
  SELECT sum(au.amount) FROM tree t JOIN authorizations au ON au.agent_id = t.agent_id
   WHERE t.ancestor_id = agents.id AND au.state NOT IN ('RELEASED', 'REJECTED')
), 0);--> statement-breakpoint
-- The audit log is append-only. (TRUNCATE, used by tests, doesn't fire row triggers.)
CREATE FUNCTION audit_chain_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_chain is append-only';
END $$;--> statement-breakpoint
CREATE TRIGGER audit_chain_no_update_delete BEFORE UPDATE OR DELETE ON audit_chain
  FOR EACH ROW EXECUTE FUNCTION audit_chain_append_only();
