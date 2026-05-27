CREATE TABLE "workflow_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"params" jsonb,
	"status" varchar(20) DEFAULT 'ready' NOT NULL,
	"last_run_id" varchar,
	"last_dag_status" varchar(20),
	"run_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_job" ADD CONSTRAINT "workflow_job_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_job" ADD CONSTRAINT "workflow_job_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workflow_job_org" ON "workflow_job" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_job_status" ON "workflow_job" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_workflow_job_workflow" ON "workflow_job" USING btree ("workflow_id");