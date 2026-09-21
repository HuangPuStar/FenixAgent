import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { listAgentMcpIds, syncAgentMcps } from "../server/repositories/agent-config-mcp";
import { listAgentSkillIds, syncAgentSkills } from "../server/repositories/agent-config-skill";
import { initializeAgentConfigModuleConfig } from "../server/testing";

/**
 * Agent 关联边（`agent_config_skill` / `agent_config_mcp`）的持久化访问。
 *
 * 两张表随 Agent 配置聚合根迁入本包（任务 1.7 B7），与 `agent-config-site-app` 是同形的三张关联表；
 * 这里把两张同形表按参数化用例覆盖，而不是复制两份逐字相同的测试：
 * - list* 透传 SELECT 结果
 * - sync* 全量覆盖（先删后插；空数组只删不插；空串视为"未选择"被过滤）
 */
const LINK_TABLES = [
  {
    table: "agent_config_skill",
    /** 关联列名；insert 的每一行就是 `{ agentConfigId, [column] }`。 */
    column: "skillId",
    listIds: listAgentSkillIds,
    syncIds: syncAgentSkills,
  },
  {
    table: "agent_config_mcp",
    column: "mcpServerId",
    listIds: listAgentMcpIds,
    syncIds: syncAgentMcps,
  },
] as const;

describe("agent-config 关联边仓储", () => {
  beforeEach(() => {
    // 复位替身并初始化应用基础设施（DB 句柄经转发代理，见 `../server/testing.ts`）。
    initializeAgentConfigModuleConfig();
  });

  afterEach(() => {
    resetAllStubs();
  });

  for (const { table, column, listIds, syncIds } of LINK_TABLES) {
    describe(table, () => {
      // 列表读取只投影关联列：返回的是 id 数组，调用方（agent-associations）自行取标签投影。
      test("list 返回关联 id 数组", async () => {
        stubDb({
          select: () => ({
            from: () => ({
              where: () => Promise.resolve([{ [column]: "link-1" }, { [column]: "link-2" }]),
            }),
          }),
        });

        expect(await listIds("agent-cfg-1")).toEqual(["link-1", "link-2"]);
      });

      // 空数组表示"清空关联"：必须只删不插，否则会写出指向不存在资源的空行。
      test("sync 空数组只删不插", async () => {
        const deleteWhere = jestFn();
        stubDb({
          delete: () => ({ where: deleteWhere }),
          insert: () => {
            throw new Error("sync 空数组时不应调用 insert");
          },
        });

        await syncIds("agent-cfg-1", []);

        expect(deleteWhere.calls).toHaveLength(1);
      });

      // 全量覆盖语义：先按 agentConfigId 删干净，再插入过滤后的关联行。
      test("sync 非空数组先删后插并过滤空串", async () => {
        const deleteWhere = jestFn();
        const insertValues: unknown[] = [];
        stubDb({
          delete: () => ({ where: deleteWhere }),
          insert: () => ({
            values: (rows: unknown[]) => {
              insertValues.push(...rows);
              return Promise.resolve(undefined);
            },
          }),
        });

        await syncIds("agent-cfg-1", ["link-1", "", "link-2"]);

        expect(deleteWhere.calls).toHaveLength(1);
        expect(insertValues).toEqual([
          { agentConfigId: "agent-cfg-1", [column]: "link-1" },
          { agentConfigId: "agent-cfg-1", [column]: "link-2" },
        ]);
      });
    });
  }
});

/** 极简 jest-like 函数 recorder，避免引入 jest 依赖（与 `agent-config-site-app.test.ts` 同形）。 */
function jestFn() {
  const calls: unknown[][] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args);
  };
  fn.calls = calls;
  return fn as unknown as { (...args: unknown[]): void; calls: unknown[][] };
}
