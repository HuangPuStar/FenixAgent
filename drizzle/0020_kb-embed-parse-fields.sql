ALTER TABLE "knowledge_base" ADD COLUMN "embedding_model" varchar(255);--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "parse_method" varchar(20);--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "chunk_method" varchar(40);
