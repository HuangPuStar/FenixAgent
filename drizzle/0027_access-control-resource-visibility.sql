ALTER TABLE IF EXISTS "agent_config" ADD COLUMN IF NOT EXISTS "visibility" varchar(20) DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE IF EXISTS "mcp_server" ADD COLUMN IF NOT EXISTS "visibility" varchar(20) DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE IF EXISTS "provider" ADD COLUMN IF NOT EXISTS "visibility" varchar(20) DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE IF EXISTS "skill" ADD COLUMN IF NOT EXISTS "visibility" varchar(20) DEFAULT 'private' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_config_org_visibility" ON "agent_config" USING btree ("organization_id","visibility");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_server_org_visibility" ON "mcp_server" USING btree ("organization_id","visibility");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_org_visibility" ON "provider" USING btree ("organization_id","visibility");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_org_visibility" ON "skill" USING btree ("organization_id","visibility");