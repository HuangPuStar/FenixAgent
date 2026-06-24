CREATE TABLE "agent_site_app" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"remote_app_id" varchar(64) NOT NULL,
	"name" varchar(32) NOT NULL,
	"description" text,
	"platform_token" text NOT NULL,
	"platform_token_id" varchar(64) NOT NULL,
	"visibility" varchar(20) DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_site_app" ADD CONSTRAINT "agent_site_app_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_site_app_remote_app_id" ON "agent_site_app" USING btree ("remote_app_id");--> statement-breakpoint
CREATE INDEX "idx_agent_site_app_org_visibility" ON "agent_site_app" USING btree ("organization_id","visibility");--> statement-breakpoint
CREATE INDEX "idx_agent_site_app_org" ON "agent_site_app" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_agent_site_app_user" ON "agent_site_app" USING btree ("user_id");