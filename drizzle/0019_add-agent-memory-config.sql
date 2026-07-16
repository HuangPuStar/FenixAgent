CREATE TABLE "agent_memory_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_config_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_memory_config_agent_config_id_unique" UNIQUE("agent_config_id")
);
--> statement-breakpoint
ALTER TABLE "agent_memory_config" ADD CONSTRAINT "agent_memory_config_agent_config_id_agent_config_id_fk" FOREIGN KEY ("agent_config_id") REFERENCES "public"."agent_config"("id") ON DELETE cascade ON UPDATE no action;