CREATE TYPE "public"."provider_protocol" AS ENUM('openai', 'anthropic');--> statement-breakpoint
CREATE TABLE "machine" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"user_id" text,
	"agent_name" varchar NOT NULL,
	"status" varchar DEFAULT 'online' NOT NULL,
	"machine_info" jsonb,
	"labels" jsonb,
	"max_sessions" integer DEFAULT 5,
	"heartbeat_interval_ms" integer DEFAULT 30000,
	"last_heartbeat_at" timestamp with time zone,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registry_event" (
	"id" text PRIMARY KEY NOT NULL,
	"machine_id" text NOT NULL,
	"type" varchar NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "workflow_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
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
ALTER TABLE "agent_config" ADD COLUMN "machine_id" text;--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "protocol" "provider_protocol" DEFAULT 'openai' NOT NULL;--> statement-breakpoint
ALTER TABLE "registry_event" ADD CONSTRAINT "registry_event_machine_id_machine_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machine"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_board" ADD CONSTRAINT "workflow_board_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_job" ADD CONSTRAINT "workflow_job_board_id_workflow_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."workflow_board"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_job" ADD CONSTRAINT "workflow_job_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_job" ADD CONSTRAINT "workflow_job_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_trigger" ADD CONSTRAINT "workflow_trigger_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_machine_org" ON "machine" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_machine_status" ON "machine" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_registry_event_machine" ON "registry_event" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "idx_registry_event_type" ON "registry_event" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_board_org_name" ON "workflow_board" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "idx_workflow_board_org" ON "workflow_board" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_job_board" ON "workflow_job" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_job_org" ON "workflow_job" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_job_status" ON "workflow_job" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_workflow_job_workflow" ON "workflow_job" USING btree ("workflow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_trigger_hash" ON "workflow_trigger" USING btree ("public_hash");--> statement-breakpoint
CREATE INDEX "idx_workflow_trigger_org_workflow" ON "workflow_trigger" USING btree ("organization_id","workflow_id");--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_machine_id_machine_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machine"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider" DROP COLUMN "npm";