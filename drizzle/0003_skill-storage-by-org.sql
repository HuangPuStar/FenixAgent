CREATE TABLE "data_migrate_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_data_migrate_record_name" ON "data_migrate_record" USING btree ("name");--> statement-breakpoint
ALTER TABLE "skill" DROP COLUMN "content_path";