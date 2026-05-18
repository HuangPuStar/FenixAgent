ALTER TABLE "share_link" ADD COLUMN "team_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "share_link" ADD CONSTRAINT "share_link_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_api_key_team_id" ON "api_key" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "idx_share_link_team_id" ON "share_link" USING btree ("team_id");