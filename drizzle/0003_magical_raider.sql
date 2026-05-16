ALTER TABLE "scheduled_task" ALTER COLUMN "environment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_task" ALTER COLUMN "task" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_task" ALTER COLUMN "timeout_minutes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_task" ADD COLUMN "url" text NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_task" ADD COLUMN "method" varchar(10) DEFAULT 'POST' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_task" ADD COLUMN "headers" jsonb;--> statement-breakpoint
ALTER TABLE "scheduled_task" ADD COLUMN "body" text;