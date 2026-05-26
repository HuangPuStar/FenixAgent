CREATE TABLE "workflow_trigger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"type" varchar(30) DEFAULT 'webhook' NOT NULL,
	"public_hash" varchar(64) NOT NULL,
	"secret" varchar,
	"config" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_trigger_public_hash_unique" UNIQUE("public_hash")
);
--> statement-breakpoint
ALTER TABLE "workflow_trigger" ADD CONSTRAINT "workflow_trigger_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_trigger_hash" ON "workflow_trigger" USING btree ("public_hash");--> statement-breakpoint
CREATE INDEX "idx_workflow_trigger_org_workflow" ON "workflow_trigger" USING btree ("organization_id","workflow_id");