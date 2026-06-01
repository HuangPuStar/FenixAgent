CREATE TYPE "public"."provider_protocol" AS ENUM('openai', 'anthropic');--> statement-breakpoint
ALTER TABLE "provider" RENAME COLUMN "npm" TO "protocol";--> statement-breakpoint
UPDATE "provider"
SET "protocol" = CASE
	WHEN "protocol"::text ILIKE '%anthropic%' THEN 'anthropic'
	ELSE 'openai'
END
WHERE "protocol" IS NULL
	OR "protocol"::text NOT IN ('openai', 'anthropic');--> statement-breakpoint
ALTER TABLE "provider" ALTER COLUMN "protocol" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "provider" ALTER COLUMN "protocol" TYPE "public"."provider_protocol" USING "protocol"::"public"."provider_protocol";--> statement-breakpoint
ALTER TABLE "provider" ALTER COLUMN "protocol" SET DEFAULT 'openai';--> statement-breakpoint
ALTER TABLE "provider" ALTER COLUMN "protocol" SET NOT NULL;
