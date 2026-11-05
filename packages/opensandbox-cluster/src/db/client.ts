import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

/** Open the cluster database, creating its data directory on first startup. */
export function createDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

export type ClusterDatabase = ReturnType<typeof createDatabase>["db"];
