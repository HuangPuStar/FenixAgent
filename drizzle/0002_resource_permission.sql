CREATE TYPE "public"."resource_permission_action" AS ENUM('read');--> statement-breakpoint
CREATE TYPE "public"."resource_permission_principal" AS ENUM('all', 'organization');--> statement-breakpoint
CREATE TYPE "public"."resource_permission_type" AS ENUM('provider', 'skill', 'mcp_server');--> statement-breakpoint
CREATE TABLE "resource_permission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"resource_type" "resource_permission_type" NOT NULL,
	"resource_id" text NOT NULL,
	"principal_type" "resource_permission_principal" NOT NULL,
	"principal_id" text,
	"action" "resource_permission_action" DEFAULT 'read' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_resource_permission_unique" ON "resource_permission" USING btree ("organization_id","resource_type","resource_id","principal_type","principal_id","action");--> statement-breakpoint
CREATE INDEX "idx_resource_permission_org_type" ON "resource_permission" USING btree ("organization_id","resource_type");--> statement-breakpoint
CREATE INDEX "idx_resource_permission_principal_action" ON "resource_permission" USING btree ("principal_type","principal_id","action");--> statement-breakpoint
CREATE INDEX "idx_resource_permission_resource" ON "resource_permission" USING btree ("resource_type","resource_id");