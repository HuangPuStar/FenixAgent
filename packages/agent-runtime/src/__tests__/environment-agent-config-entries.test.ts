// `@fenix/agent-runtime/server/environment` 上两个**跨包入口**的契约测试（任务 1.7 B8）。
//
// 两个入口的消费方只有 `@fenix/agent-config` 的删除与重启编排：`environment` / `agent_instance` 两张表
// 随 B8 迁入本包后，agent-config 不再直读表对象，改经这两个入口取 id / 在**自己的事务**里删环境行。
// 因此本文件断言的是「跨包契约的形状」而不是仓储行为：
//   1. 只取 id（调用方要的是交给运行时停止实例的标识，不是环境行）；
//   2. 归属条件同时收 `organization_id` 与 `agent_config_id`——入口自己不做授权（调用方 Facade 已判），
//      双条件让「组织与配置配错」退化成空操作，而不是一次跨组织的删除；
//   3. 删除入口在**传入的句柄**上执行、不自己开事务，否则「删环境 + 删配置」的同事务语义就不成立。
//
// 谓词只断言 Drizzle 真正交给数据库的那份 `SQL`（列名 + 绑定值），不在替身里自己实现一遍行过滤——
// 后者只能证明替身自己是对的。助手与 `@fenix/resource-prod-view` / `@fenix/resource-agent-config` 的同名
// 实现刻意各自保留一份：它依赖 Drizzle chunk 的内部形状，抽到公共测试包会让任一侧的调整牵动其余包。

import { afterEach, describe, expect, test } from "bun:test";
import { initializeAgentRuntimeModuleConfig } from "@fenix/agent-runtime/server/testing";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import type { AgentRuntimeDatabase } from "../server/db";
import { deleteEnvironmentsByAgentConfig, listEnvironmentIdsByAgentConfig } from "../server/repositories/environment";

/** 摊平 Drizzle `SQL` chunk 树收集叶子列名（列节点同时带 `name` / `dataType` / `columnType`）。 */
function collectColumnNames(node: unknown, names: string[] = []): string[] {
  if (node === null || typeof node !== "object") return names;
  const chunks = (node as { queryChunks?: readonly unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) collectColumnNames(chunk, names);
    return names;
  }
  const candidate = node as { name?: unknown; dataType?: unknown; columnType?: unknown };
  if (typeof candidate.name === "string" && candidate.dataType !== undefined && candidate.columnType !== undefined) {
    names.push(candidate.name);
  }
  return names;
}

/** 收集 `Param` 叶子的绑定值：列名只证明「下推了某一列」，值才证明「用的是调用方给的那个组织」。 */
function collectParamValues(node: unknown, values: string[] = []): string[] {
  if (node === null || typeof node !== "object") return values;
  const chunks = (node as { queryChunks?: readonly unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) collectParamValues(chunk, values);
    return values;
  }
  const candidate = node as { value?: unknown; encoder?: unknown };
  if (candidate.encoder !== undefined && candidate.value !== undefined) {
    values.push(String(candidate.value));
  }
  return values;
}

describe("environment 的跨包取数入口", () => {
  afterEach(() => {
    resetAllStubs();
  });

  // 只取 id：调用方拿这些标识去停止实例 / 关闭连接，环境行本身不在契约里。
  test("按 Agent 配置取环境 id 列表", async () => {
    initializeAgentRuntimeModuleConfig();
    const whereClauses: unknown[] = [];
    stubDb({
      select: () => ({
        from: () => ({
          where: (clause: unknown) => {
            whereClauses.push(clause);
            return Promise.resolve([{ id: "env-1" }, { id: "env-2" }]);
          },
        }),
      }),
    });

    const ids = await listEnvironmentIdsByAgentConfig({ organizationId: "org-1", agentConfigId: "agc-1" });

    expect(ids).toEqual(["env-1", "env-2"]);
    // 取数条件落在归属两列上，且绑的是调用方给的组织与配置——写死常量同样能通过列名断言，因此必须看值。
    expect(collectColumnNames(whereClauses[0])).toEqual(["organization_id", "agent_config_id"]);
    expect(collectParamValues(whereClauses[0])).toEqual(["org-1", "agc-1"]);
  });

  // 没有环境绑定该 Agent 是合法状态（新建后未启动过），返回空集合而不是抛错。
  test("无绑定环境时返回空数组", async () => {
    initializeAgentRuntimeModuleConfig();
    stubDb({
      select: () => ({
        from: () => ({ where: () => Promise.resolve([]) }),
      }),
    });

    expect(await listEnvironmentIdsByAgentConfig({ organizationId: "org-1", agentConfigId: "agc-1" })).toEqual([]);
  });
});

describe("environment 的跨包删除入口", () => {
  afterEach(() => {
    resetAllStubs();
  });

  /**
   * 记录调用点的删除替身。
   *
   * `transaction` 故意抛错：本入口的契约是「在调用方给出的事务句柄上执行」，自己再开一层事务会与调用方
   * 的事务产生嵌套/独立提交，语义就不再是「删环境 + 删配置」原子完成——因此一旦被调用就当场失败。
   */
  function createHandleCapture() {
    const whereClauses: unknown[] = [];
    const handle = {
      delete: () => ({
        where: (clause: unknown) => {
          whereClauses.push(clause);
          return Promise.resolve({ count: 2 });
        },
      }),
      transaction: () => {
        throw new Error("删除入口不得自己开事务：事务边界由调用方（agent-config 的删除路径）持有");
      },
    };
    return { handle: handle as unknown as AgentRuntimeDatabase, whereClauses };
  }

  // 传入句柄即执行现场：删除落在调用方的事务句柄上，且不开第二层事务。
  test("在调用方传入的句柄上执行删除", async () => {
    const { handle, whereClauses } = createHandleCapture();
    // 本包的模块句柄被桩成「一旦被取用就报错」——若实现绕开传入句柄改用 getAgentRuntimeDatabase()，
    // 失败信息会直接指出越过了契约，而不是一句「undefined 不是函数」。
    initializeAgentRuntimeModuleConfig();
    stubDb({
      delete: () => {
        throw new Error("删除入口必须使用调用方传入的句柄，不得回落到本包模块句柄");
      },
    });

    await deleteEnvironmentsByAgentConfig(handle, { organizationId: "org-1", agentConfigId: "agc-1" });

    expect(whereClauses).toHaveLength(1);
  });

  // 归属条件同时收 `organization_id` 与 `agent_config_id`。本入口自己不做授权（调用方 Facade 已判
  // `delete` 动作），因此当调用方把组织与配置配错时，双条件让这次写变成空操作，而不是一篇跨组织的删除。
  test("删除谓词同时下推组织与配置两列", async () => {
    const { handle, whereClauses } = createHandleCapture();

    await deleteEnvironmentsByAgentConfig(handle, { organizationId: "org-1", agentConfigId: "agc-1" });

    expect(collectColumnNames(whereClauses[0])).toEqual(["organization_id", "agent_config_id"]);
    expect(collectParamValues(whereClauses[0])).toEqual(["org-1", "agc-1"]);
  });
});
