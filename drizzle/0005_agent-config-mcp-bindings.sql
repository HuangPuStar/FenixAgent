CREATE TABLE "agent_config_mcp" (
	"agent_config_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_config_mcp" ADD CONSTRAINT "agent_config_mcp_agent_config_id_agent_config_id_fk" FOREIGN KEY ("agent_config_id") REFERENCES "public"."agent_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_mcp" ADD CONSTRAINT "agent_config_mcp_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_config_mcp_pk" ON "agent_config_mcp" USING btree ("agent_config_id","mcp_server_id");