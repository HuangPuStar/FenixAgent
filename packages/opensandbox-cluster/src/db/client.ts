import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export function createDatabase(path: string) {
  const sqlite = new Database(path);
  sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

export type ClusterDatabase = ReturnType<typeof createDatabase>["db"];
