ALTER TABLE "agent_site_app" ADD COLUMN "app_type" varchar(20) DEFAULT 'pocketbase' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_site_app" ADD COLUMN "entry_file" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_site_app" ADD COLUMN "active_slot" varchar(8);--> statement-breakpoint
ALTER TABLE "agent_site_app" ADD COLUMN "deployed_at" timestamp with time zone;