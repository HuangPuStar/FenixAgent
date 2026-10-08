ALTER TABLE "workflow_v2_platform_account" RENAME COLUMN "coze_user_id" TO "platform_user_id";--> statement-breakpoint
ALTER TABLE "workflow_v2_platform_account" RENAME COLUMN "coze_space_id" TO "platform_space_id";--> statement-breakpoint
ALTER TABLE "workflow_v2_org_app" RENAME COLUMN "coze_app_id" TO "app_id";--> statement-breakpoint
ALTER TABLE "workflow_v2_workflow" RENAME COLUMN "coze_workflow_id" TO "upstream_workflow_id";--> statement-breakpoint
ALTER TABLE "workflow_v2_audit_log" RENAME COLUMN "coze_workflow_id" TO "upstream_workflow_id";--> statement-breakpoint
ALTER INDEX "idx_workflow_v2_platform_account_coze_user" RENAME TO "idx_workflow_v2_platform_account_platform_user";--> statement-breakpoint
ALTER INDEX "idx_workflow_v2_org_app_coze_app" RENAME TO "idx_workflow_v2_org_app_app";--> statement-breakpoint
ALTER INDEX "idx_workflow_v2_workflow_coze_workflow" RENAME TO "idx_workflow_v2_workflow_upstream";
