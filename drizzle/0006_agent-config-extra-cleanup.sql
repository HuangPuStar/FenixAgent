ALTER TABLE "agent_config" ADD COLUMN "extra" jsonb;--> statement-breakpoint
ALTER TABLE "agent_config" DROP COLUMN "steps";--> statement-breakpoint
ALTER TABLE "agent_config" DROP COLUMN "mode";--> statement-breakpoint
ALTER TABLE "agent_config" DROP COLUMN "permission";--> statement-breakpoint
ALTER TABLE "agent_config" DROP COLUMN "variant";--> statement-breakpoint
ALTER TABLE "agent_config" DROP COLUMN "temperature";--> statement-breakpoint
ALTER TABLE "agent_config" DROP COLUMN "top_p";--> statement-breakpoint
ALTER TABLE "agent_config" DROP COLUMN "disable";--> statement-breakpoint
ALTER TABLE "agent_config" DROP COLUMN "hidden";--> statement-breakpoint
ALTER TABLE "agent_config" DROP COLUMN "color";