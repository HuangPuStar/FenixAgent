-- 专家库（agent_expert / agent_config_expert）与 agent_config.model_ids 预选模型列。
-- 范围严格限定为设计 §7 规定的三项；agent_session / scheduled_task 的残留清理
-- 属独立的历史迁移决策（见 git 记录 bec7615f），不随特性迁移捆绑下发。
CREATE TABLE "agent_config_expert" (
	"agent_config_id" uuid NOT NULL,
	"expert_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_expert" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text,
	"name" varchar NOT NULL,
	"description" text,
	"prompt" text NOT NULL,
	"skills" jsonb,
	"model" varchar,
	"mode" varchar DEFAULT 'subagent' NOT NULL,
	"temperature" double precision,
	"steps" integer,
	"permission" jsonb,
	"builtin" boolean DEFAULT false NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"extra" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "model_ids" uuid[];--> statement-breakpoint
ALTER TABLE "agent_config_expert" ADD CONSTRAINT "agent_config_expert_agent_config_id_agent_config_id_fk" FOREIGN KEY ("agent_config_id") REFERENCES "public"."agent_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_config_expert" ADD CONSTRAINT "agent_config_expert_expert_id_agent_expert_id_fk" FOREIGN KEY ("expert_id") REFERENCES "public"."agent_expert"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_expert" ADD CONSTRAINT "agent_expert_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_config_expert_pk" ON "agent_config_expert" USING btree ("agent_config_id","expert_id");--> statement-breakpoint
CREATE INDEX "idx_agent_config_expert_agent_config" ON "agent_config_expert" USING btree ("agent_config_id");--> statement-breakpoint
CREATE INDEX "idx_agent_config_expert_expert" ON "agent_config_expert" USING btree ("expert_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_expert_org_name" ON "agent_expert" USING btree ("organization_id","name");