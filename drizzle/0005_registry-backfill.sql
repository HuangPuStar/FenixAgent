CREATE TABLE IF NOT EXISTS "machine" (
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
CREATE TABLE IF NOT EXISTS "registry_event" (
	"id" text PRIMARY KEY NOT NULL,
	"machine_id" text NOT NULL,
	"type" varchar NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN IF NOT EXISTS "machine_id" text;--> statement-breakpoint
ALTER TABLE "agent_config" ALTER COLUMN "machine_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "registry_event" DROP CONSTRAINT IF EXISTS "registry_event_machine_id_machine_id_fk";--> statement-breakpoint
ALTER TABLE "registry_event" ADD CONSTRAINT "registry_event_machine_id_machine_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machine"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_machine_org" ON "machine" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_machine_status" ON "machine" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_registry_event_machine" ON "registry_event" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_registry_event_type" ON "registry_event" USING btree ("type");--> statement-breakpoint
ALTER TABLE "agent_config" DROP CONSTRAINT IF EXISTS "agent_config_machine_id_machine_id_fk";--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_machine_id_machine_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machine"("id") ON DELETE set null ON UPDATE no action;
