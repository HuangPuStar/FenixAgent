CREATE TABLE "agent_concurrency_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"agent_max_concurrency" integer,
	"user_agent_max_concurrency" integer,
	"scheduled_agent_max_concurrency" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_concurrency_policy_positive" CHECK (("agent_concurrency_policy"."agent_max_concurrency" is null or "agent_concurrency_policy"."agent_max_concurrency" > 0) and ("agent_concurrency_policy"."user_agent_max_concurrency" is null or "agent_concurrency_policy"."user_agent_max_concurrency" > 0) and ("agent_concurrency_policy"."scheduled_agent_max_concurrency" is null or "agent_concurrency_policy"."scheduled_agent_max_concurrency" > 0)),
	CONSTRAINT "agent_concurrency_policy_user_scope" CHECK ("agent_concurrency_policy"."user_id" is null or ("agent_concurrency_policy"."agent_max_concurrency" is null and "agent_concurrency_policy"."scheduled_agent_max_concurrency" is null and "agent_concurrency_policy"."user_agent_max_concurrency" is not null))
);
--> statement-breakpoint
ALTER TABLE "agent_concurrency_policy" ADD CONSTRAINT "agent_concurrency_policy_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_concurrency_policy_global" ON "agent_concurrency_policy" USING btree ((true)) WHERE "agent_concurrency_policy"."user_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_concurrency_policy_user" ON "agent_concurrency_policy" USING btree ("user_id");