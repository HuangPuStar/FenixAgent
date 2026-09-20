// prod_view 仓储的数据访问边界：组织谓词必须进 WHERE、写入负载的组织与创建者必须来自调用方给定的
// 组织与用户、更新只写「显式给出」的字段。这些不变量错一条就是跨组织越权或静默覆盖。
//
// 覆盖边界：本文件用链式替身覆盖语句构造（列名与绑定参数）与结果映射；`where(eq(...))` 的 SQL 语义
// （真实列名、类型编码、执行计划）由 Drizzle 与数据库负责，不在替身里复刻。

import { beforeEach, describe, expect, test } from "bun:test";
import { initializeTestApplicationInfrastructure, resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { prodViewRepo } from "../server/repositories/prod-view";
import {
  AGENT_ID,
  collectColumnNames,
  collectParamValues,
  createProdViewDbStub,
  type ProdViewDbStub,
  prodViewRow,
} from "./prod-view-db-stub";

/**
 * 装配 DB 替身。
 *
 * 顺序即生产装配顺序：先登记句柄替身，再初始化基础设施（基础设施持有的是**引用**，反转顺序会让
 * `getProdViewDatabase()` 读到未初始化的默认值并抛错）。本包不读模块配置，`moduleConfigs` 留空。
 */
function installDbStub(stub: ProdViewDbStub): void {
  resetAllStubs();
  stubDb(stub.db);
  initializeTestApplicationInfrastructure();
}

/** 最近一条 WHERE 条件里出现的列名与绑定参数值。 */
function lastWhere(stub: ProdViewDbStub): { columns: string[]; values: string[] } {
  const clause = stub.whereClauses.at(-1);
  return { columns: collectColumnNames(clause), values: collectParamValues(clause) };
}

describe("prod_view 仓储", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  // 详情按「组织 + 主键」双条件定位：少了组织谓词，`a/<b 的 id>` 就能读到别的组织的视图。
  test("getById 下推 organization_id 与 id 两个谓词", async () => {
    const stub = createProdViewDbStub([prodViewRow({ id: "pv-1", organizationId: "org-1" })]);
    installDbStub(stub);

    const row = await prodViewRepo.getById("org-1", "pv-1");

    expect(row?.id).toBe("pv-1");
    const where = lastWhere(stub);
    expect(where.columns).toContain("organization_id");
    expect(where.columns).toContain("id");
    expect(where.values).toContain("org-1");
    expect(where.values).toContain("pv-1");
  });

  // 没有行时必须返回 undefined（上层据此映射 404），不得抛出或返回空对象。
  test("getById 无命中行时返回 undefined", async () => {
    installDbStub(createProdViewDbStub([]));

    await expect(prodViewRepo.getById("org-1", "pv-missing")).resolves.toBeUndefined();
  });

  // 不带过滤条件时只应下推组织谓词：多推一个业务条件会把本组织可见的视图静默过滤掉。
  test("listByOrg 未给过滤条件时只下推组织谓词", async () => {
    const stub = createProdViewDbStub([prodViewRow({ organizationId: "org-1" })]);
    installDbStub(stub);

    const rows = await prodViewRepo.listByOrg("org-1");

    expect(rows).toHaveLength(1);
    const where = lastWhere(stub);
    expect(where.columns).toContain("organization_id");
    expect(where.values).toContain("org-1");
    expect(where.columns).not.toContain("agent_id");
    expect(where.columns).not.toContain("enabled");
  });

  // 给了过滤条件才下推对应列：`enabled: false` 是有效过滤值，不能被 `if (filters?.enabled)` 吞掉。
  test("listByOrg 按给定过滤条件下推 agent_id 与 enabled", async () => {
    const stub = createProdViewDbStub([prodViewRow()]);
    installDbStub(stub);

    await prodViewRepo.listByOrg("org-1", { agentId: AGENT_ID, enabled: false });

    const where = lastWhere(stub);
    expect(where.columns).toContain("agent_id");
    expect(where.columns).toContain("enabled");
    expect(where.values).toContain(AGENT_ID);
    expect(where.values).toContain("false");
  });

  // 组织与创建者只能由调用方（服务层，源自认证上下文）写入，不接受请求体里的同名值——否则请求可以
  // 把视图创建到别的组织名下。
  test("create 以调用方给定的组织与创建者写入", async () => {
    const stub = createProdViewDbStub([]);
    installDbStub(stub);

    const row = await prodViewRepo.create({
      organizationId: "org-9",
      name: "视图",
      agentId: AGENT_ID,
      modulesConfig: { chatView: { enabled: true } },
      createdBy: "user-9",
    });

    expect(row.organizationId).toBe("org-9");
    expect(row.createdBy).toBe("user-9");
    expect(stub.writes.inserts[0]).toMatchObject({
      organizationId: "org-9",
      name: "视图",
      agentId: AGENT_ID,
      createdBy: "user-9",
    });
    // 未给描述时写 null（列可空），而不是 undefined 落到 Drizzle 的缺省处理之外。
    expect(stub.writes.inserts[0].description).toBeNull();
  });

  // 未给模块配置时写空对象：读取侧把它当「全部模块按默认值」解释，写 null 会在前端解构处炸开。
  test("create 未给 modulesConfig 时写入空对象", async () => {
    const stub = createProdViewDbStub([]);
    installDbStub(stub);

    await prodViewRepo.create({ organizationId: "org-1", name: "视图", agentId: AGENT_ID, createdBy: "user-1" });

    expect(stub.writes.inserts[0].modulesConfig).toEqual({});
  });

  // 更新只写显式给出的字段：把未给的字段一起写回会用读取到的旧值覆盖并发更新（例如列表页与详情页
  // 同时编辑），因此补丁里只能出现本次请求涉及的列，外加必刷新的 updatedAt。
  test("update 只写给定字段并刷新 updatedAt", async () => {
    const stub = createProdViewDbStub([prodViewRow({ id: "pv-1", name: "旧名", enabled: true })]);
    installDbStub(stub);

    const row = await prodViewRepo.update("org-1", "pv-1", { name: "新名" });

    expect(row?.name).toBe("新名");
    const patch = stub.writes.patches[0];
    expect(Object.keys(patch).sort()).toEqual(["name", "updatedAt"]);
    expect(patch.updatedAt).toBeInstanceOf(Date);
    // 未被请求改动的列保留原值。
    expect(row?.enabled).toBe(true);
  });

  // 写入未命中（行已被并发删除）时返回 undefined，交由服务层区分 404 与「已删除」。
  test("update 未命中行时返回 undefined", async () => {
    installDbStub(createProdViewDbStub([]));

    await expect(prodViewRepo.update("org-1", "pv-missing", { name: "新名" })).resolves.toBeUndefined();
  });

  // 删除按「组织 + 主键」定位并返回布尔结果：谓词缺组织会误删别的组织的同 id 行。
  test("delete 按组织与主键定位并返回删除结果", async () => {
    const stub = createProdViewDbStub([prodViewRow({ id: "pv-1" })]);
    installDbStub(stub);

    await expect(prodViewRepo.delete("org-1", "pv-1")).resolves.toBe(true);

    const where = lastWhere(stub);
    expect(where.columns).toContain("organization_id");
    expect(where.columns).toContain("id");
    expect(where.values).toContain("org-1");
  });

  // 未命中时返回 false（而不是抛错）：服务层据此回 DELETE_FAILED，状态码仍是 404。
  test("delete 未命中时返回 false", async () => {
    installDbStub(createProdViewDbStub([]));

    await expect(prodViewRepo.delete("org-1", "pv-missing")).resolves.toBe(false);
  });
});
