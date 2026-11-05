import type { Database } from "bun:sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { type ClusterDatabase, createDatabase } from "./client";

/** Apply generated table rebuilds with foreign key enforcement restored and checked afterward. */
export function migrateConnection(db: ClusterDatabase, sqlite: Database): void {
  // SQLite ignores foreign_keys changes inside Drizzle's transaction; table rebuilds need it disabled before BEGIN.
  sqlite.exec("PRAGMA foreign_keys = OFF");
  try {
    migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
    if (sqlite.query("PRAGMA foreign_key_check").all().length > 0)
      throw new Error("Cluster migration produced invalid foreign key relationships");
  } finally {
    sqlite.exec("PRAGMA foreign_keys = ON");
  }
}

export function migrateDatabase(databasePath: string): void {
  const { db, sqlite } = createDatabase(databasePath);
  try {
    migrateConnection(db, sqlite);
  } finally {
    sqlite.close();
  }
}

if (import.meta.main) {
  const path = process.env.DATABASE_PATH ?? "/data/opensandbox-cluster.db";
  migrateDatabase(path);
}
