CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"name" varchar NOT NULL,
	"model" varchar,
	"prompt" text,
	"steps" integer,
	"mode" varchar(20),
	"permission" jsonb,
	"variant" varchar,
	"temperature" numeric,
	"top_p" numeric,
	"disable" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"color" varchar,
	"description" text,
	"knowledge" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_config_skill" (
	"agent_config_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_knowledge_binding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_config_id" uuid NOT NULL,
	"knowledge_base_id" uuid NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_session" (
	"id" varchar PRIMARY KEY NOT NULL,
	"environment_id" varchar,
	"title" varchar,
	"status" varchar(50) DEFAULT 'idle' NOT NULL,
	"source" varchar(50) DEFAULT 'acp' NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_time_window" integer,
	"rate_limit_max" integer,
	"request_count" integer DEFAULT 0 NOT NULL,
	"remaining" integer,
	"last_request" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "channel_binding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" varchar NOT NULL,
	"chat_id" varchar,
	"agent_id" varchar NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environment" (
	"id" varchar PRIMARY KEY NOT NULL,
	"name" varchar NOT NULL,
	"description" text,
	"workspace_path" varchar NOT NULL,
	"agent_config_id" uuid,
	"status" varchar(50) DEFAULT 'idle' NOT NULL,
	"machine_name" varchar,
	"branch" varchar,
	"git_repo_url" varchar,
	"max_sessions" integer DEFAULT 1 NOT NULL,
	"worker_type" varchar(50) DEFAULT 'acp' NOT NULL,
	"capabilities" jsonb,
	"secret" varchar NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"auto_start" boolean DEFAULT true NOT NULL,
	"last_poll_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "im_channel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"name" varchar NOT NULL,
	"description" text,
	"platform" varchar NOT NULL,
	"credentials" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'disconnected' NOT NULL,
	"last_error" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "im_channel_route" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"chat_id" varchar,
	"environment_id" varchar NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" varchar NOT NULL,
	"role" varchar NOT NULL,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"team_id" text,
	"inviter_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_base" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"name" varchar NOT NULL,
	"slug" varchar NOT NULL,
	"description" text,
	"provider" varchar DEFAULT 'openviking' NOT NULL,
	"remote_id" varchar,
	"remote_account_id" varchar,
	"remote_user_id" varchar,
	"status" varchar(50) DEFAULT 'empty' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_resource" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"knowledge_base_id" uuid NOT NULL,
	"source_type" varchar NOT NULL,
	"source_name" varchar NOT NULL,
	"source_path" text,
	"remote_id" varchar,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_server" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"name" varchar NOT NULL,
	"type" varchar(10) NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_tool" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"server_name" varchar NOT NULL,
	"tool_name" varchar NOT NULL,
	"description" text,
	"input_schema" jsonb,
	"inspected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"model_id" varchar NOT NULL,
	"display_name" varchar,
	"modalities" jsonb,
	"limit_config" jsonb,
	"cost" jsonb,
	"options" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar NOT NULL,
	"slug" varchar NOT NULL,
	"logo" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"name" varchar NOT NULL,
	"display_name" varchar,
	"npm" varchar,
	"base_url" text,
	"api_key" text,
	"extra_options" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"name" varchar NOT NULL,
	"description" text,
	"cron" varchar NOT NULL,
	"timezone" varchar,
	"enabled" boolean DEFAULT true NOT NULL,
	"url" text NOT NULL,
	"method" varchar(10) DEFAULT 'POST' NOT NULL,
	"headers" jsonb,
	"body" text,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"last_status" varchar,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "share_event_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"share_link_id" uuid,
	"events" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"session_id" varchar NOT NULL,
	"environment_id" varchar NOT NULL,
	"token" varchar NOT NULL,
	"mode" varchar(20) NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" varchar NOT NULL,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_link_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "skill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"name" varchar NOT NULL,
	"description" text,
	"content_path" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_execution_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"status" varchar NOT NULL,
	"error" text,
	"duration" integer,
	"triggered_by" varchar DEFAULT 'cron' NOT NULL,
	"workspace_path" varchar,
	"workspace_name" varchar,
	"task_snapshot" jsonb,
	"skip_reason" text,
	"result_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" varchar NOT NULL,
	"email" varchar NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_config" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"default_agent" varchar,
	"current_model" varchar,
	"small_model" varchar,
	"permission" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "workflow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"name" varchar NOT NULL,
	"description" text,
	"latest_version" integer,
	"storage_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" varchar NOT NULL,
	"run_id" varchar NOT NULL,
	"project_id" varchar,
	"node_id" varchar,
	"timestamp" timestamp with time zone NOT NULL,
	"type" varchar NOT NULL,
	"node_type" varchar,
	"metadata" jsonb,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_node_output" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" varchar NOT NULL,
	"node_id" varchar NOT NULL,
	"stdout" text DEFAULT '' NOT NULL,
	"json" jsonb,
	"exit_code" integer NOT NULL,
	"size" integer,
	"ref" text,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer,
	"status" varchar DEFAULT 'running' NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"step_results" jsonb,
	"triggered_by" varchar DEFAULT 'manual' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" varchar NOT NULL,
	"run_id" varchar NOT NULL,
	"workflow_id" uuid,
	"last_event_id" varchar NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"node_states" jsonb NOT NULL,
	"dag_status" varchar NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"file_path" text NOT NULL,
	"status" varchar(20) NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_skill" ADD CONSTRAINT "agent_config_skill_agent_config_id_agent_config_id_fk" FOREIGN KEY ("agent_config_id") REFERENCES "public"."agent_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_skill" ADD CONSTRAINT "agent_config_skill_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_binding" ADD CONSTRAINT "agent_knowledge_binding_agent_config_id_agent_config_id_fk" FOREIGN KEY ("agent_config_id") REFERENCES "public"."agent_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_knowledge_binding" ADD CONSTRAINT "agent_knowledge_binding_knowledge_base_id_knowledge_base_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_agent_config_id_agent_config_id_fk" FOREIGN KEY ("agent_config_id") REFERENCES "public"."agent_config"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_channel" ADD CONSTRAINT "im_channel_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_channel_route" ADD CONSTRAINT "im_channel_route_channel_id_im_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."im_channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_channel_route" ADD CONSTRAINT "im_channel_route_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD CONSTRAINT "knowledge_base_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_resource" ADD CONSTRAINT "knowledge_resource_knowledge_base_id_knowledge_base_id_fk" FOREIGN KEY ("knowledge_base_id") REFERENCES "public"."knowledge_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model" ADD CONSTRAINT "model_provider_id_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."provider"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider" ADD CONSTRAINT "provider_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_task" ADD CONSTRAINT "scheduled_task_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_event_snapshot" ADD CONSTRAINT "share_event_snapshot_share_link_id_share_link_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "public"."share_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_execution_log" ADD CONSTRAINT "task_execution_log_task_id_scheduled_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."scheduled_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_config" ADD CONSTRAINT "user_config_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_workflow_id_workflow_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_config_org_name" ON "agent_config" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_config_skill_pk" ON "agent_config_skill" USING btree ("agent_config_id","skill_id");--> statement-breakpoint
CREATE INDEX "idx_agent_knowledge_binding_agent_config" ON "agent_knowledge_binding" USING btree ("agent_config_id");--> statement-breakpoint
CREATE INDEX "idx_agent_knowledge_binding_kb" ON "agent_knowledge_binding" USING btree ("knowledge_base_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_knowledge_binding_agent_config_kb" ON "agent_knowledge_binding" USING btree ("agent_config_id","knowledge_base_id");--> statement-breakpoint
CREATE INDEX "idx_agent_session_org_environment_id" ON "agent_session" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "idx_apikey_key" ON "apikey" USING btree ("key");--> statement-breakpoint
CREATE INDEX "idx_apikey_reference" ON "apikey" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "idx_channel_binding_platform" ON "channel_binding" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "idx_channel_binding_agent_id" ON "channel_binding" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_environment_org_name" ON "environment" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "idx_im_channel_org_platform" ON "im_channel" USING btree ("organization_id","platform");--> statement-breakpoint
CREATE INDEX "idx_im_channel_route_channel" ON "im_channel_route" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "idx_im_channel_route_chat" ON "im_channel_route" USING btree ("channel_id","chat_id");--> statement-breakpoint
CREATE INDEX "idx_invitation_org" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_knowledge_base_org_slug" ON "knowledge_base" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "idx_knowledge_base_org_status" ON "knowledge_base" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_knowledge_resource_kb" ON "knowledge_resource" USING btree ("knowledge_base_id");--> statement-breakpoint
CREATE INDEX "idx_knowledge_resource_status" ON "knowledge_resource" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_mcp_server_org_name" ON "mcp_server" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "idx_mcp_tool_org_server" ON "mcp_tool" USING btree ("organization_id","server_name");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_member_org_user" ON "member" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_provider_model" ON "model" USING btree ("provider_id","model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_org_provider_model" ON "model" USING btree ("organization_id","provider_id","model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_provider_org_name" ON "provider" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "idx_scheduled_task_org_id" ON "scheduled_task" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_share_link_org_id" ON "share_link" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_skill_org_name" ON "skill" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_org_name" ON "workflow" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "idx_workflow_event_run" ON "workflow_event" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_event_org" ON "workflow_event" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_event_run_type" ON "workflow_event" USING btree ("run_id","type");--> statement-breakpoint
CREATE INDEX "idx_workflow_event_run_node" ON "workflow_event" USING btree ("run_id","node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_node_output_run_node" ON "workflow_node_output" USING btree ("run_id","node_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_node_output_org" ON "workflow_node_output" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_run_workflow" ON "workflow_run" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_run_status" ON "workflow_run" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_workflow_snapshot_run" ON "workflow_snapshot" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_snapshot_org" ON "workflow_snapshot" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_snapshot_workflow" ON "workflow_snapshot" USING btree ("workflow_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_version_unique" ON "workflow_version" USING btree ("workflow_id","version");