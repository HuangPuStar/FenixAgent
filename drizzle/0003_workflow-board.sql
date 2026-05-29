CREATE TABLE "workflow_board" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" varchar(100) NOT NULL,
	"user_id" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_job" ADD COLUMN "board_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_board" ADD CONSTRAINT "workflow_board_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_board_org_name" ON "workflow_board" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "idx_workflow_board_org" ON "workflow_board" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "workflow_job" ADD CONSTRAINT "workflow_job_board_id_workflow_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."workflow_board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workflow_job_board" ON "workflow_job" USING btree ("board_id");