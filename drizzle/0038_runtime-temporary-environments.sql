CREATE TABLE "agent_environment_policy" (
	"agent_config_id" uuid PRIMARY KEY NOT NULL,
	"ttl_seconds" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_environment_policy_ttl_positive" CHECK ("agent_environment_policy"."ttl_seconds" > 0)
);
--> statement-breakpoint
DROP INDEX "idx_environment_org_user_agent_config";--> statement-breakpoint
ALTER TABLE "environment" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "environment" ADD COLUMN "expiry_reclaimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_environment_policy" ADD CONSTRAINT "agent_environment_policy_agent_config_id_agent_config_id_fk" FOREIGN KEY ("agent_config_id") REFERENCES "public"."agent_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_environment_expires_at" ON "environment" USING btree ("expires_at") WHERE "environment"."expires_at" is not null and "environment"."expiry_reclaimed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_environment_org_user_agent_config" ON "environment" USING btree ("organization_id","user_id","agent_config_id") WHERE "environment"."agent_config_id" is not null and "environment"."id" not like 'temp-%';