CREATE TYPE "public"."approval_verdict" AS ENUM('APPROVED', 'REJECTED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"authorization_id" uuid NOT NULL,
	"approver_id" uuid,
	"verdict" "approval_verdict" NOT NULL,
	"approver_address" text,
	"signature" text,
	"deadline" timestamp with time zone,
	"policy_version" integer,
	"note" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"wallet_address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authorizations" ADD COLUMN "vault_tx_nonce" integer;--> statement-breakpoint
ALTER TABLE "authorizations" ADD COLUMN "vault_tx_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "authorizations" ADD COLUMN "refund_transfer_id" text;--> statement-breakpoint
ALTER TABLE "authorizations" ADD COLUMN "refund_tx" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "approver_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_authorization_id_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."authorizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_id_approvers_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."approvers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvers" ADD CONSTRAINT "approvers_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_authorization_idx" ON "approvals" USING btree ("authorization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approvers_owner_wallet_idx" ON "approvers" USING btree ("owner_id","wallet_address");--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_approver_id_approvers_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."approvers"("id") ON DELETE no action ON UPDATE no action;