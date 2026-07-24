--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "embedding_model" varchar;
--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "parse_method" varchar(20);
ALTER TABLE "knowledge_base" ADD COLUMN "chunk_method" varchar(40);
