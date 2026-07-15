DROP INDEX "idx_scheduled_task_v2_org_id";--> statement-breakpoint
CREATE INDEX "idx_scheduled_task_v2_user_org" ON "scheduled_task_v2" USING btree ("user_id","organization_id");