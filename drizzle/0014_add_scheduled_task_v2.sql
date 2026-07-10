CREATE TABLE "scheduled_task_v2" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"name" varchar NOT NULL,
	"description" text,
	"cron" varchar NOT NULL,
	"timezone" varchar,
	"enabled" boolean DEFAULT true NOT NULL,
	"timeout_seconds" integer DEFAULT 300 NOT NULL,
	"agent_id" uuid,
	"type" varchar NOT NULL,
	"definition" jsonb NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"last_status" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_execution_log" DROP CONSTRAINT "task_execution_log_task_id_scheduled_task_id_fk";
--> statement-breakpoint
ALTER TABLE "scheduled_task_v2" ADD CONSTRAINT "scheduled_task_v2_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_task_v2" ADD CONSTRAINT "scheduled_task_v2_agent_id_agent_config_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent_config"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_scheduled_task_v2_org_id" ON "scheduled_task_v2" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_scheduled_task_v2_agent_id" ON "scheduled_task_v2" USING btree ("agent_id");