import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://rcs:rcs@localhost:5432/rcs";
export const client = postgres(DATABASE_URL);
export const db = drizzle(client, { schema });

export async function initDb() {
  await client`SELECT 1`;
}
