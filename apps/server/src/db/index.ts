import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { parseDatabaseConnectionPoolConfig } from "../env";
import { observeDatabasePoolMaximum } from "../telemetry/database-metrics";
import { attachDatabasePoolErrorLogger, buildDatabasePoolOptions } from "./pool-config";
import * as schema from "./schema";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://rcs:rcs@localhost:5432/rcs";
const poolConfig = parseDatabaseConnectionPoolConfig();
observeDatabasePoolMaximum(poolConfig.RCS_DB_POOL_MAX);

export const client = new Pool({ connectionString: DATABASE_URL, ...buildDatabasePoolOptions(poolConfig) });
attachDatabasePoolErrorLogger(client);

export const db = drizzle(client, { schema });

export async function initDb() {
  await client.query("SELECT 1");
}
