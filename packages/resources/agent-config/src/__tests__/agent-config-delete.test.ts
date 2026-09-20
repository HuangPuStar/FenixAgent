import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AuthorizedResourceQuery } from "@fenix/platform-sdk";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { environment } from "@server/db/schema";
import {
  type AgentConfigQueryStorage,
  createAgentConfigRepository,
} from "../server/repositories/agent-config-resource";
import { initializeAgentConfigModuleConfig } from "../server/testing";

/**
 * Agent 删除的**持久化语义**（S4 接缝迁移）。
 *
 * 删除 Agent 必须先清掉它绑定的 environment 行、再删资源行，且两步在同一事务内——否则残留的
 * environment 会以已删除的 agent_config 为归属进入脏数据（历史缺陷，见
 * docs/issues/2026-08-19-agent-delete-instance-leak.md 的删除路径说明）。
 *
 * 接缝说明：这段顺序约束落在 Repository（`removeWithEnvironments`），不再由已下线的
 * `services/config/agent-config.ts#deleteAgentConfig` 承载；"删前停止运行实例"是 Facade 的职责，
 * 由 `agent-config-delete-stops-instances.test.ts` 覆盖。授权查询端口在这里只是构造依赖，删除路径
 * 不读资源行，因此任何调用都视为行为回归。
 */

/** 删除路径不读资源行：授权查询端口一旦被调用即失败，防止用例悄悄依赖别的接缝。 */
function unusedQueryPort(): AuthorizedResourceQuery<AgentConfigQueryStorage> {
  const unused = () => {
    throw new Error("删除路径不应经授权查询端口读取资源行");
  };
  return { list: unused, count: unused, findById: unused };
}

describe("deleteAgentConfig", () => {
  beforeEach(() => {
    // 复位替身并初始化应用基础设施（DB 句柄经转发代理，见 `../server/testing.ts`）——仓储经
    // `getDatabase()` 取句柄，不再是模块级 `db` 导出。
    initializeAgentConfigModuleConfig();
  });

  afterEach(() => {
    resetAllStubs();
  });

  // 事务内的删除顺序固定为 environment → agent_config，且资源行删除成功时返回 true。
  test("deletes bound environments before deleting the agent config", async () => {
    const deletedTables: string[] = [];

    stubDb({
      transaction: async (callback: (tx: Record<string, unknown>) => Promise<boolean>) =>
        callback({
          delete: (table: unknown) => ({
            where: () => {
              if (table === environment) {
                deletedTables.push("environment");
                return Promise.resolve({ count: 2 });
              }
              deletedTables.push("agent_config");
              return { returning: async () => [{ id: "agc_1" }] };
            },
          }),
        }),
    });

    const repository = createAgentConfigRepository(unusedQueryPort());
    const deleted = await repository.removeWithEnvironments({ resourceId: "agc_1", organizationId: "org_1" });

    expect(deleted).toBe(true);
    expect(deletedTables).toEqual(["environment", "agent_config"]);
  });
});
