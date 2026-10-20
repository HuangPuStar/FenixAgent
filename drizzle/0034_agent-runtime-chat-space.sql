CREATE TABLE "chat_space" (
	"id" varchar(80) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"user_id" text NOT NULL,
	"instance_uid" varchar(80) NOT NULL,
	"session_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_space_name_check" CHECK (char_length(btrim("chat_space"."name")) BETWEEN 1 AND 100)
);
--> statement-breakpoint
ALTER TABLE "chat_space" ADD CONSTRAINT "chat_space_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_space" ADD CONSTRAINT "chat_space_instance_uid_agent_instance_id_fk" FOREIGN KEY ("instance_uid") REFERENCES "public"."agent_instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chat_space_scope_name" ON "chat_space" USING btree ("instance_uid","user_id","name");