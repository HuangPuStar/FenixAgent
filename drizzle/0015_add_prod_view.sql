CREATE TABLE "prod_view" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" varchar NOT NULL,
	"description" text,
	"agent_id" text NOT NULL,
	"modules_config" jsonb DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prod_view" ADD CONSTRAINT "prod_view_agent_id_agent_config_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_prod_view_org_id" ON "prod_view" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_prod_view_agent_id" ON "prod_view" USING btree ("agent_id");