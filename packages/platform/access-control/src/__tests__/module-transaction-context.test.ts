import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ModuleManifest } from "@fenix/platform-sdk";
import { runInTransaction } from "@fenix/platform-sdk/server";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { pgTable, text } from "drizzle-orm/pg-core";
import { moduleManifest } from "../../fenix.module";

const table = pgTable("transaction_probe", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id"),
  visibility: text("visibility"),
});
const columns = { id: table.id, organizationId: table.organizationId, visibility: table.visibility };
const declaration = {
  id: "transaction-probe",
  kind: "resource",
  dependsOn: [],
  accessControlBindings: [{ resourceType: "probe", table, columns }],
} satisfies ModuleManifest;
type Row = { id: string; organizationId: string; visibility: string };
let rows: Row[];
let transactionRows: Row[];

/** 替身分别保存根连接和事务连接的数据，模拟未提交数据的可见性。 */
function database(read: () => Row[]) {
  return {
    execute: async () => {},
    select: () => ({
      from: () => ({
        where: () => Object.assign(Promise.resolve(read()), { limit: async () => read() }),
      }),
    }),
    update: () => ({
      set: (values: { visibility: string }) => ({
        where: async () => {
          for (const row of read()) row.visibility = values.visibility;
        },
      }),
    }),
  };
}

beforeEach(() => {
  resetAllStubs();
  rows = [{ id: "agent", organizationId: "org", visibility: "private" }];
  transactionRows = [];
  initializeTestApplicationInfrastructure({
    database: {
      ...database(() => rows),
      transaction: async (callback: (tx: ReturnType<typeof database>) => Promise<unknown>) => {
        transactionRows = structuredClone(rows);
        const result = await callback(database(() => transactionRows));
        rows = transactionRows;
        return result;
      },
    },
  });
});
afterEach(resetAllStubs);

/** 使用生产模块工厂，防止仅测试独立授权类而遗漏装配时缓存连接的问题。 */
function assemble() {
  return moduleManifest.create({ env: {}, modules: new Map(), declarations: [declaration], registerCleanup: () => {} });
}

// 新建资源后，授权回读应立即看到同一事务内尚未提交的资源。
test("授权查询跟随当前事务读取未提交资源", async () => {
  const suite = await assemble();
  await runInTransaction(async () => {
    transactionRows = [{ id: "new-agent", organizationId: "org", visibility: "private" }];
    const result = await suite.authorizedQuery.findById({
      resourceType: "probe",
      resourceId: "new-agent",
      table,
      columns,
    });
    expect(result?.id).toBe("new-agent");
    const scopes = await suite.scopeStore.getMany({ resourceType: "probe", resourceIds: ["new-agent"] });
    expect(scopes.has("new-agent")).toBe(true);
  });
  const scopes = await suite.scopeStore.getMany({ resourceType: "probe", resourceIds: ["new-agent"] });
  expect(scopes.has("new-agent")).toBe(true);
});

// 关联保存失败时，公开范围也必须随事务回滚，不能从根连接提前提交。
test("公开范围更新随外层事务失败回滚", async () => {
  const suite = await assemble();
  await expect(
    runInTransaction(async () => {
      await suite.scopeStore.update({
        resourceType: "probe",
        resourceId: "agent",
        scope: { organizationId: "org", visibility: "public" },
      });
      throw new Error("binding failed");
    }),
  ).rejects.toThrow("binding failed");
  expect(rows[0]?.visibility).toBe("private");
  expect(transactionRows[0]?.visibility).toBe("public");
});
