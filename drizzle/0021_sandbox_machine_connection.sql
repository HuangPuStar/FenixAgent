CREATE TABLE "sandbox_instance" (
	"id" text PRIMARY KEY NOT NULL,
	"machine_id" text NOT NULL,
	"provider_key" varchar(64) NOT NULL,
	"sandbox_pool_id" text NOT NULL,
	"user_id" text NOT NULL,
	"external_sandbox_id" varchar,
	"status" varchar(32) NOT NULL,
	"resolved_config" jsonb NOT NULL,
	"resource_overrides" jsonb,
	"provider_payload" jsonb,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_pool" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"name" varchar NOT NULL,
	"provider_key" varchar(64) NOT NULL,
	"image" varchar NOT NULL,
	"default_resources" jsonb NOT NULL,
	"extra" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "agent_node" jsonb;--> statement-breakpoint
ALTER TABLE "machine" ADD COLUMN "type" varchar(32) DEFAULT 'machine' NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_instance" ADD CONSTRAINT "sandbox_instance_sandbox_pool_id_sandbox_pool_id_fk" FOREIGN KEY ("sandbox_pool_id") REFERENCES "public"."sandbox_pool"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_instance" ADD CONSTRAINT "sandbox_instance_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_pool" ADD CONSTRAINT "sandbox_pool_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sandbox_instance_machine_id" ON "sandbox_instance" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "idx_sandbox_instance_pool_user" ON "sandbox_instance" USING btree ("sandbox_pool_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_sandbox_instance_external_id" ON "sandbox_instance" USING btree ("external_sandbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sandbox_instance_active_unique" ON "sandbox_instance" USING btree ("provider_key","sandbox_pool_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_sandbox_pool_organization" ON "sandbox_pool" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_sandbox_pool_provider" ON "sandbox_pool" USING btree ("provider_key");--> statement-breakpoint
CREATE INDEX "idx_machine_type" ON "machine" USING btree ("type");