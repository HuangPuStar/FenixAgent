CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
ALTER TYPE "public"."provider_protocol" ADD VALUE 'litellm';--> statement-breakpoint
CREATE TABLE "agent_litellm_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"agent_config_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"litellm_org_id" text NOT NULL,
	"litellm_user_id" text NOT NULL,
	"litellm_key_id" text NOT NULL,
	"litellm_key" text NOT NULL,
	"litellm_agent_id" text NOT NULL,
	"key_alias" varchar(255),
	"max_budget" numeric(12, 6),
	"budget_duration" varchar(20) DEFAULT '30d',
	"tags" jsonb DEFAULT '[]'::jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_litellm_key_user_agent" ON "agent_litellm_key" USING btree ("user_id","agent_config_id");--> statement-breakpoint
CREATE INDEX "idx_agent_litellm_key_org_agent" ON "agent_litellm_key" USING btree ("organization_id","agent_config_id");--> statement-breakpoint
CREATE INDEX "idx_agent_litellm_key_user" ON "agent_litellm_key" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_agent_litellm_key_lkey" ON "agent_litellm_key" USING btree ("litellm_key_id");