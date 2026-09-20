// 人员树仓储（本包唯一数据访问点）的行为用例。
//
// 为什么必须补：协议层用例注入的是假 service（`setSystemPeopleTreeServiceForTests`），仓储的查询构造
// 完全覆盖不到；谓词、投影或排序写错时接口照样返回 200，只是内容悄悄错（跨组织看到别人的智能体、
// 名称与机器列错位、顺序随执行计划抖动）。这里断言的是「交给数据库的那份条件与投影」，不是替身自己的
// 过滤结果（替身刻意不解释 WHERE，见 system-people-db-stub.ts 文件头）。

import { beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { listAgentConfigsByOrganization } from "../server/repositories/system-people-repository";
import {
  collectColumnNames,
  collectParamValues,
  createPeopleTreeDbStub,
  systemPeopleAgentRow,
} from "./system-people-db-stub";

describe("system-people repository", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  // 组织谓词必须下推到 SQL：按 org-1 查询时只应取到 org-1 的行，且绑定参数就是调用方给的组织 id。
  test("按组织下推 WHERE 谓词，不跨组织取行", async () => {
    const stub = createPeopleTreeDbStub({
      "org-1": [systemPeopleAgentRow({ id: "agent-1" })],
      "org-2": [systemPeopleAgentRow({ id: "agent-2" })],
    });
    stubDb(stub.db);

    const rows = await listAgentConfigsByOrganization("org-1");

    expect(rows.map((row) => row.id)).toEqual(["agent-1"]);
    expect(stub.whereClauses).toHaveLength(1);
    // 参数值钉住「用的是调用方的组织」；列名钉住「组织确实是 SQL 里的过滤列」——两者缺一都可能是假隔离。
    expect(collectParamValues(stub.whereClauses[0])).toEqual(["org-1"]);
    expect(collectColumnNames(stub.whereClauses[0])).toContain("organization_id");
  });

  // 投影只取展示与分组必需的列，且别名到真实列的映射正确（错位会让界面显示别人的名称/机器，不报错）。
  test("投影列与列名映射固定，不整行返回", async () => {
    const stub = createPeopleTreeDbStub({ "org-1": [systemPeopleAgentRow()] });
    stubDb(stub.db);

    await listAgentConfigsByOrganization("org-1");

    expect(Object.keys(stub.projections[0]).sort()).toEqual([
      "description",
      "engineType",
      "id",
      "machineId",
      "name",
      "userId",
    ]);
    expect(
      Object.values(stub.projections[0])
        .flatMap((column) => collectColumnNames(column))
        .sort(),
    ).toEqual(["description", "engine_type", "id", "machine_id", "name", "user_id"]);
  });

  // 排序在 SQL 内完成（name → id）：服务层按名称分组排序，若这里顺序不定，同一份数据在不同执行计划下
  // 输出会抖动，断言与界面都不可复现。
  test("排序下推到 SQL：name → id", async () => {
    const stub = createPeopleTreeDbStub({ "org-1": [systemPeopleAgentRow()] });
    stubDb(stub.db);

    await listAgentConfigsByOrganization("org-1");

    expect(stub.orderByClauses).toHaveLength(1);
    expect(stub.orderByClauses[0]).toHaveLength(2);
    expect(collectColumnNames(stub.orderByClauses[0][0])).toEqual(["name"]);
    expect(collectColumnNames(stub.orderByClauses[0][1])).toEqual(["id"]);
  });

  // 可空列原样透传：description / machineId / engineType 为空时必须保持 null，不得补默认值或空串
  // （补值会把「未配置 machine」伪装成「已绑定机器」，人员树上的归属判断随之出错）。
  test("可空列原样返回 null，不补默认值", async () => {
    const stub = createPeopleTreeDbStub({
      "org-1": [systemPeopleAgentRow({ description: null, machineId: null, engineType: null })],
    });
    stubDb(stub.db);

    const [row] = await listAgentConfigsByOrganization("org-1");

    expect(row).toEqual({
      id: "agent-1",
      userId: "user-1",
      name: "代码助手",
      description: null,
      machineId: null,
      engineType: null,
    });
  });

  // 组织没有任何智能体时返回空数组：空集合是合法状态，不能抛错也不能返回 undefined 让上层崩溃。
  test("组织无智能体时返回空数组", async () => {
    const stub = createPeopleTreeDbStub({});
    stubDb(stub.db);

    expect(await listAgentConfigsByOrganization("org-empty")).toEqual([]);
  });
});
