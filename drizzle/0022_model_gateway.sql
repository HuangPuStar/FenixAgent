CREATE TYPE "public"."model_gateway_credential_status" AS ENUM('active', 'blocked', 'error');--> statement-breakpoint
CREATE TYPE "public"."provider_kind" AS ENUM('direct', 'gateway');--> statement-breakpoint
CREATE TABLE "model_gateway_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gateway_provider_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_config_id" uuid NOT NULL,
	"external_credential_id" text NOT NULL,
	"encrypted_credential" text,
	"status" "model_gateway_credential_status" DEFAULT 'active' NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "kind" "provider_kind" DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider" ADD COLUMN "gateway_type" varchar;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_gateway_credential_subject" ON "model_gateway_credential" USING btree ("gateway_provider_id","organization_id","user_id","agent_config_id");--> statement-breakpoint
CREATE INDEX "idx_model_gateway_credential_external_id" ON "model_gateway_credential" USING btree ("external_credential_id");--> statement-breakpoint
CREATE INDEX "idx_model_gateway_credential_status_id" ON "model_gateway_credential" USING btree ("status","id");
