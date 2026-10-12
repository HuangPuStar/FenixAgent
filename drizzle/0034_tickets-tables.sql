CREATE TABLE "ticket_index" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"issue_number" varchar(32) NOT NULL,
	"title" text NOT NULL,
	"state" varchar(16) NOT NULL,
	"author_id" text,
	"author_name" text,
	"assignee_id" text,
	"label_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_version" varchar(64) NOT NULL,
	"provider_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_status" varchar(20) DEFAULT 'ready' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"object_kind" varchar(16) NOT NULL,
	"provider_object_id" varchar(64) NOT NULL,
	"message_id" varchar(64) NOT NULL,
	"author_id" text NOT NULL,
	"author_name_snapshot" text NOT NULL,
	"body_hash" varchar(64) NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"last_editor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"recipient_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"issue_number" varchar(32) NOT NULL,
	"event_key" varchar(128) NOT NULL,
	"type" varchar(32) NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid,
	"actor_id" text NOT NULL,
	"kind" varchar(32) NOT NULL,
	"target_id" varchar(64),
	"idempotency_key" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"message_id" varchar(64),
	"expected_version" varchar(64),
	"intent" jsonb,
	"step" varchar(32),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"repository_ref" uuid NOT NULL,
	"connection_id" varchar(64) NOT NULL,
	"provider_repository_id" varchar(64) NOT NULL,
	"owner" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_index" ADD CONSTRAINT "ticket_index_project_id_ticket_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."ticket_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_project_id_ticket_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."ticket_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_notifications" ADD CONSTRAINT "ticket_notifications_project_id_ticket_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."ticket_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_operations" ADD CONSTRAINT "ticket_operations_project_id_ticket_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."ticket_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_projects" ADD CONSTRAINT "ticket_projects_repository_ref_git_repository_bindings_id_fk" FOREIGN KEY ("repository_ref") REFERENCES "public"."git_repository_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_index_project_issue_uq" ON "ticket_index" USING btree ("project_id","issue_number");--> statement-breakpoint
CREATE INDEX "ticket_index_project_state_idx" ON "ticket_index" USING btree ("project_id","state","issue_number");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_messages_object_uq" ON "ticket_messages" USING btree ("project_id","object_kind","provider_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_messages_message_id_uq" ON "ticket_messages" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "ticket_messages_project_idx" ON "ticket_messages" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_notifications_recipient_event_uq" ON "ticket_notifications" USING btree ("recipient_id","event_key");--> statement-breakpoint
CREATE INDEX "ticket_notifications_inbox_idx" ON "ticket_notifications" USING btree ("recipient_id","read_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_operations_idempotency_uq" ON "ticket_operations" USING btree ("organization_id","actor_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "ticket_operations_status_idx" ON "ticket_operations" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "ticket_operations_project_idx" ON "ticket_operations" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_projects_repository_ref_uq" ON "ticket_projects" USING btree ("repository_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_projects_default_active_uq" ON "ticket_projects" USING btree ("organization_id") WHERE "ticket_projects"."is_default" AND "ticket_projects"."status" = 'active';--> statement-breakpoint
CREATE INDEX "ticket_projects_org_idx" ON "ticket_projects" USING btree ("organization_id");