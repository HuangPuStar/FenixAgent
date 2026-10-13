import { expect, test } from "bun:test";
import { pgTable, varchar } from "drizzle-orm/pg-core";
import type { AccessControlDatabase } from "../database";
import { ColumnResourceScopeStore } from "../scope/column-resource-scope-store";

const probeTable = pgTable("scope_store_probe", {
  id: varchar("id", { length: 36 }).primaryKey(),
  organizationId: varchar("organization_id", { length: 36 }),
  visibility: varchar("visibility", { length: 20 }),
});

/** 初始化不应访问数据库；一旦实际访问，测试立即暴露该错误。 */
const database = new Proxy(
  {},
  {
    get() {
      throw new Error("initialize 不应访问数据库");
    },
  },
) as unknown as AccessControlDatabase;

function createStore(): ColumnResourceScopeStore {
  return new ColumnResourceScopeStore(database, [
    {
      resourceType: "scope-store-probe",
      table: probeTable,
      columns: {
        id: probeTable.id,
        organizationId: probeTable.organizationId,
        visibility: probeTable.visibility,
      },
    },
  ]);
}

// 已注册资源随 INSERT 写入范围，初始化仅校验绑定且不访问数据库。
test("已注册资源的初始化是无数据库访问的 no-op", async () => {
  await expect(
    createStore().initialize({
      resourceType: "scope-store-probe",
      resourceId: "resource-1",
      scope: { organizationId: "org-1", visibility: "private" },
    }),
  ).resolves.toBeUndefined();
});

// 未注册资源不能在 no-op 路径静默通过，必须保留统一的装配错误。
test("未注册资源的初始化拒绝缺失存储绑定", async () => {
  await expect(
    createStore().initialize({
      resourceType: "not-declared",
      resourceId: "resource-1",
      scope: { organizationId: "org-1", visibility: "private" },
    }),
  ).rejects.toThrow("资源 not-declared 未注册存储绑定，无法解析归属范围");
});
