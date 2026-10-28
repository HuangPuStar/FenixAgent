CREATE TABLE "im_channel_conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"chat_type" varchar(16) NOT NULL,
	"chat_id" varchar NOT NULL,
	"agent_config_id" uuid NOT NULL,
	"rcs_session_id" varchar(128) NOT NULL,
	"acp_session_id" varchar(128),
	"last_event_at" timestamp with time zone,
	"last_reply_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "im_channel_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"event_uuid" varchar(128) NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"chat_type" varchar(16) NOT NULL,
	"chat_id" varchar NOT NULL,
	"text" text,
	"read_at" timestamp with time zone,
	"sender_id" varchar(128),
	"agent_config_id" uuid,
	"status" varchar(20) NOT NULL,
	"delivery_via" varchar(16),
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"ack_sent_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "im_channel_route" DROP CONSTRAINT "im_channel_route_environment_id_environment_id_fk";
--> statement-breakpoint
DROP INDEX "idx_im_channel_route_channel";--> statement-breakpoint
DROP INDEX "idx_im_channel_route_chat";--> statement-breakpoint
-- 历史路由只记 environment_id，且该表在本版本前没有写入方；先加可空列、回填、再收紧，避免非空库直接失败。
ALTER TABLE "im_channel_route" ADD COLUMN "chat_type" varchar(16);--> statement-breakpoint
ALTER TABLE "im_channel_route" ADD COLUMN "agent_config_id" uuid;--> statement-breakpoint
UPDATE "im_channel_route" AS "r" SET "agent_config_id" = "e"."agent_config_id" FROM "environment" AS "e" WHERE "r"."environment_id" = "e"."id" AND "e"."agent_config_id" IS NOT NULL;--> statement-breakpoint
-- environment 已解绑或没有 Agent 配置的行无法映射到新模型，删除而不是阻塞整条迁移。
DELETE FROM "im_channel_route" WHERE "agent_config_id" IS NULL;--> statement-breakpoint
-- 旧表没有 chat_type 语义；历史行按私聊回填（该表此前无写入方，线上应为空）。
UPDATE "im_channel_route" SET "chat_type" = 'person' WHERE "chat_type" IS NULL;--> statement-breakpoint
ALTER TABLE "im_channel_route" ALTER COLUMN "chat_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "im_channel_route" ALTER COLUMN "agent_config_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "im_channel_conversation" ADD CONSTRAINT "im_channel_conversation_channel_id_im_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."im_channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_channel_conversation" ADD CONSTRAINT "im_channel_conversation_agent_config_id_agent_config_id_fk" FOREIGN KEY ("agent_config_id") REFERENCES "public"."agent_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_channel_event" ADD CONSTRAINT "im_channel_event_channel_id_im_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."im_channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "im_channel_event" ADD CONSTRAINT "im_channel_event_agent_config_id_agent_config_id_fk" FOREIGN KEY ("agent_config_id") REFERENCES "public"."agent_config"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_im_channel_conversation_chat_uq" ON "im_channel_conversation" USING btree ("channel_id","chat_type","chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_im_channel_conversation_rcs_session_uq" ON "im_channel_conversation" USING btree ("rcs_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_im_channel_event_channel_event_uq" ON "im_channel_event" USING btree ("channel_id","event_uuid");--> statement-breakpoint
CREATE INDEX "idx_im_channel_event_status" ON "im_channel_event" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "idx_im_channel_event_chat" ON "im_channel_event" USING btree ("channel_id","chat_type","chat_id","received_at");--> statement-breakpoint
ALTER TABLE "im_channel_route" ADD CONSTRAINT "im_channel_route_agent_config_id_agent_config_id_fk" FOREIGN KEY ("agent_config_id") REFERENCES "public"."agent_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_im_channel_route_exact_uq" ON "im_channel_route" USING btree ("channel_id","chat_type","chat_id") WHERE "im_channel_route"."chat_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_im_channel_route_wildcard_uq" ON "im_channel_route" USING btree ("channel_id","chat_type") WHERE "im_channel_route"."chat_id" is null;--> statement-breakpoint
CREATE INDEX "idx_im_channel_route_match" ON "im_channel_route" USING btree ("channel_id","chat_type","chat_id");--> statement-breakpoint
ALTER TABLE "im_channel_route" DROP COLUMN "environment_id";