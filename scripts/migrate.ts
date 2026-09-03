import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL || "postgres://rcs:rcs@localhost:5432/rcs";

const client = new Pool({ connectionString, max: 1 });
const db = drizzle(client);

try {
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migration completed successfully.");
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("already exists")) {
    console.warn("Migration skipped: tables already exist (database was likely created with db:push).");
    process.exitCode = 0;
  } else {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
