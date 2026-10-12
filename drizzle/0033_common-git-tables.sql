CREATE TABLE "git_event_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" varchar(128),
	"lease_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_event_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"consumer_id" varchar(64) NOT NULL,
	"event_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"delivery_id" varchar(128) NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"subject_id" varchar(128),
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_repository_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"connection_id" varchar(64) NOT NULL,
	"provider_repository_id" varchar(64) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"credential_ref" varchar(128) NOT NULL,
	"allowed_consumers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"webhook_id" varchar(64),
	"webhook_secret_ref" varchar(128),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_event_deliveries" ADD CONSTRAINT "git_event_deliveries_event_id_git_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."git_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_event_deliveries" ADD CONSTRAINT "git_event_deliveries_subscription_id_git_event_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."git_event_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_event_subscriptions" ADD CONSTRAINT "git_event_subscriptions_binding_id_git_repository_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."git_repository_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_events" ADD CONSTRAINT "git_events_binding_id_git_repository_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."git_repository_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_event_deliveries_event_subscription_uq" ON "git_event_deliveries" USING btree ("event_id","subscription_id");--> statement-breakpoint
CREATE INDEX "git_event_deliveries_dispatch_idx" ON "git_event_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "git_event_subscriptions_binding_consumer_uq" ON "git_event_subscriptions" USING btree ("binding_id","consumer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "git_events_binding_delivery_uq" ON "git_events" USING btree ("binding_id","delivery_id");--> statement-breakpoint
CREATE INDEX "git_events_received_idx" ON "git_events" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "git_repository_bindings_connection_repo_uq" ON "git_repository_bindings" USING btree ("connection_id","provider_repository_id");--> statement-breakpoint
CREATE INDEX "git_repository_bindings_org_idx" ON "git_repository_bindings" USING btree ("organization_id");