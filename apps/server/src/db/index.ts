import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { parseDatabaseConnectionPoolConfig } from "../env";
import { attachDatabasePoolErrorLogger, buildDatabasePoolOptions } from "./pool-config";
import * as schema from "./schema";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://rcs:rcs@localhost:5432/rcs";
const poolConfig = parseDatabaseConnectionPoolConfig();

export const client = new Pool({ connectionString: DATABASE_URL, ...buildDatabasePoolOptions(poolConfig) });
attachDatabasePoolErrorLogger(client);

export const db = drizzle(client, { schema });

export async function initDb() {
  await client.query("SELECT 1");
}
