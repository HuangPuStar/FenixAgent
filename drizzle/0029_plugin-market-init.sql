CREATE TABLE "plugin_market_admin_operation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" varchar(20) NOT NULL,
	"package_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"operator_user_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" text,
	CONSTRAINT "plugin_market_admin_operation_action_check" CHECK ("plugin_market_admin_operation"."action" in ('publish', 'restore', 'unpublish'))
);
--> statement-breakpoint
CREATE TABLE "plugin_market_package" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"package_name" text NOT NULL,
	"organization_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"visibility" varchar(20) DEFAULT 'public' NOT NULL,
	"latest_publication_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_market_publication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"exact_version" text NOT NULL,
	"metadata_json" text NOT NULL,
	"metadata_digest" text NOT NULL,
	"first_published_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"unpublished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_market_publication_id_package_unique" UNIQUE("id","package_id"),
	CONSTRAINT "plugin_market_publication_published_at_check" CHECK ("plugin_market_publication"."published_at" >= "plugin_market_publication"."first_published_at")
);
--> statement-breakpoint
ALTER TABLE "plugin_market_admin_operation" ADD CONSTRAINT "plugin_market_admin_operation_package_id_plugin_market_package_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."plugin_market_package"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_market_admin_operation" ADD CONSTRAINT "plugin_market_admin_operation_publication_id_plugin_market_publication_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."plugin_market_publication"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_market_admin_operation" ADD CONSTRAINT "plugin_market_admin_operation_operator_user_id_user_id_fk" FOREIGN KEY ("operator_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_market_package" ADD CONSTRAINT "plugin_market_package_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_market_package" ADD CONSTRAINT "plugin_market_package_latest_publication_fk" FOREIGN KEY ("latest_publication_id","id") REFERENCES "public"."plugin_market_publication"("id","package_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_market_publication" ADD CONSTRAINT "plugin_market_publication_package_id_plugin_market_package_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."plugin_market_package"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_plugin_market_admin_operation_occurred" ON "plugin_market_admin_operation" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_plugin_market_package_source_name" ON "plugin_market_package" USING btree ("source_id","package_name");--> statement-breakpoint
CREATE INDEX "idx_plugin_market_package_scope" ON "plugin_market_package" USING btree ("organization_id","visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_plugin_market_publication_package_version" ON "plugin_market_publication" USING btree ("package_id","exact_version");--> statement-breakpoint
CREATE INDEX "idx_plugin_market_publication_visible" ON "plugin_market_publication" USING btree ("package_id","unpublished_at","published_at" DESC NULLS LAST,"id" DESC NULLS LAST);