import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { getDatabase, runInTransaction } from "@fenix/platform-sdk/server";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { moduleManifest } from "../../fenix.module";

const connectionString = process.env.TEST_EXTERNAL_API_DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString, max: 3 }) : undefined;
const database = pool ? drizzle(pool) : undefined;
const table = pgTable("authorization_transaction_probe", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id"),
  visibility: text("visibility"),
});
const columns = { id: table.id, organizationId: table.organizationId, visibility: table.visibility };

beforeEach(() => {
  if (database) initializeTestApplicationInfrastructure({ database });
});
afterEach(resetAllStubs);
afterAll(async () => {
  await pool?.end();
});

// 授权读取与受众更新必须使用调用方事务，不能从根连接读取不到尚未提交的资源。
test.skipIf(!database)("authorization reads and scope writes share the active transaction", async () => {
  const suite = await moduleManifest.create({
    env: {},
    modules: new Map(),
    registerCleanup: () => {},
    declarations: [
      {
        id: "transaction-probe",
        kind: "resource",
        accessControlBindings: [{ resourceType: "transaction-probe", table, columns }],
      },
    ],
  });
  await runInTransaction(async () => {
    const tx = getDatabase<NonNullable<typeof database>>();
    await tx.execute(sql`CREATE TEMP TABLE authorization_transaction_probe
      (id text PRIMARY KEY, organization_id text, visibility text) ON COMMIT DROP`);
    await tx.insert(table).values({ id: "new-agent", organizationId: "org-a", visibility: "private" });
    const target = { resourceType: "transaction-probe", table, columns };
    expect((await suite.authorizedQuery.findById({ ...target, resourceId: "new-agent" }))?.id).toBe("new-agent");
    expect((await suite.authorizedQuery.list(target)).items).toHaveLength(1);
    expect(await suite.authorizedQuery.count(target)).toBe(1);
    expect(
      (await suite.scopeStore.getMany({ resourceType: "transaction-probe", resourceIds: ["new-agent"] })).get(
        "new-agent",
      )?.visibility,
    ).toBe("private");
    await suite.scopeStore.update({
      resourceType: "transaction-probe",
      resourceId: "new-agent",
      scope: { organizationId: "org-a", visibility: "public" },
    });
    const [row] = await tx.select().from(table);
    expect(row.visibility).toBe("public");
  });
});
