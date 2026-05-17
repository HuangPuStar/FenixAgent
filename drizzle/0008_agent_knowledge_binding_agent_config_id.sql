ALTER TABLE "agent_knowledge_binding" ALTER COLUMN "agent_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_knowledge_binding" ADD COLUMN "agent_config_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_knowledge_binding" ADD CONSTRAINT "agent_knowledge_binding_agent_config_id_agent_config_id_fk" FOREIGN KEY ("agent_config_id") REFERENCES "public"."agent_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_knowledge_binding_agent_config" ON "agent_knowledge_binding" USING btree ("agent_config_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_knowledge_binding_agent_config_kb" ON "agent_knowledge_binding" USING btree ("agent_config_id","knowledge_base_id");