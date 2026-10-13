CREATE TABLE "workflow_v2_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"coze_workflow_id" text,
	"request_id" text,
	"result" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_v2_org_app" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"coze_app_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_v2_platform_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coze_user_id" text NOT NULL,
	"coze_space_id" text NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"last_probe_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_v2_workflow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"coze_workflow_id" text NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"published_version" text,
	"sync_state" text DEFAULT 'active' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_workflow_v2_audit_log_org_created" ON "workflow_v2_audit_log" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_v2_org_app_organization" ON "workflow_v2_org_app" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_v2_org_app_coze_app" ON "workflow_v2_org_app" USING btree ("coze_app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_v2_platform_account_coze_user" ON "workflow_v2_platform_account" USING btree ("coze_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_v2_workflow_coze_workflow" ON "workflow_v2_workflow" USING btree ("coze_workflow_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_v2_workflow_org_deleted" ON "workflow_v2_workflow" USING btree ("organization_id","deleted_at");