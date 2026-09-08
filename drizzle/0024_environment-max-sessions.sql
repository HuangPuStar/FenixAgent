ALTER TABLE "environment" ALTER COLUMN "max_sessions" SET DEFAULT 5;--> statement-breakpoint
UPDATE "environment" SET "max_sessions" = 5 WHERE "max_sessions" = 1;