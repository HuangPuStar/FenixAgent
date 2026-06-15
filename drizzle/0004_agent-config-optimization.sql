ALTER TABLE "agent_config" ADD COLUMN "model_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_knowledge_binding" ADD COLUMN "config" jsonb;--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_model_id_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config" DROP COLUMN "knowledge";
