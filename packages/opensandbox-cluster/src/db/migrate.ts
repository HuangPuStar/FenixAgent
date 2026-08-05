import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabase } from "./client";

export function migrateDatabase(databasePath: string): void {
  const { db, sqlite } = createDatabase(databasePath);
  migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  sqlite.close();
}

if (import.meta.main) {
  const path = process.env.DATABASE_PATH ?? "/data/opensandbox-cluster.db";
  migrateDatabase(path);
}
