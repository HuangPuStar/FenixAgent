CREATE TABLE "agent_config_site_app" (
	"agent_config_id" uuid NOT NULL,
	"site_app_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_config_site_app" ADD CONSTRAINT "agent_config_site_app_agent_config_id_agent_config_id_fk" FOREIGN KEY ("agent_config_id") REFERENCES "public"."agent_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_site_app" ADD CONSTRAINT "agent_config_site_app_site_app_id_agent_site_app_id_fk" FOREIGN KEY ("site_app_id") REFERENCES "public"."agent_site_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_config_site_app_pk" ON "agent_config_site_app" USING btree ("agent_config_id","site_app_id");--> statement-breakpoint
CREATE INDEX "idx_agent_config_site_app_agent_config" ON "agent_config_site_app" USING btree ("agent_config_id");--> statement-breakpoint
CREATE INDEX "idx_agent_config_site_app_site_app" ON "agent_config_site_app" USING btree ("site_app_id");