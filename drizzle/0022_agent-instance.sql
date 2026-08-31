CREATE TYPE "public"."agent_instance_creation_source" AS ENUM('user', 'api', 'workflow');--> statement-breakpoint
CREATE TABLE "agent_instance" (
	"id" varchar(80) PRIMARY KEY NOT NULL,
	"environment_id" varchar NOT NULL,
	"owner_user_id" text NOT NULL,
	"creation_source" "agent_instance_creation_source" NOT NULL,
	"name" varchar(100) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_instance_default_check" CHECK ("agent_instance"."is_default" = ("agent_instance"."creation_source" = 'user' AND "agent_instance"."name" = 'default')),
	CONSTRAINT "agent_instance_name_check" CHECK (char_length(btrim("agent_instance"."name")) BETWEEN 1 AND 100)
);
--> statement-breakpoint
ALTER TABLE "agent_instance" ADD CONSTRAINT "agent_instance_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instance" ADD CONSTRAINT "agent_instance_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instance" ADD CONSTRAINT "agent_instance_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_instance_creation_key" ON "agent_instance" USING btree ("environment_id","owner_user_id","creation_source","name");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_instance_default_owner" ON "agent_instance" USING btree ("environment_id","owner_user_id") WHERE "agent_instance"."is_default" = true;
DROP TABLE IF EXISTS "scheduled_task";
