import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import {
  bindMachineIdByAgentName,
  isAgentConfigBoundToMachine,
  searchAgentConfigsSystem,
} from "../server/repositories/agent-config";
import { initializeAgentConfigModuleConfig } from "../server/testing";
import { collectColumnNames, collectParamValues } from "./fixtures";

/**
 * 跨包取数面（`repositories/agent-config.ts`）的谓词下推断言。
 *
 * 这些函数是别的包读 `agent_config` 的唯一窗口（§4.8 第 4 条：调用期只能经 owner 的公开 service / DTO
 * 取数），SQL 形状就是它们对外的行为：列集合决定调用方拿得到什么，谓词决定它拿到谁的数据。因此用例
 * 断言的是「哪几列、绑了谁的值、怎么排序/分页」，而不是「有没有调用查询」。
 *
 * `listAgentConfigsByOrganization` 的下推断言在 `agent-config-ownership-projection.test.ts`（随 Observer
 * 的系统人员树查询一起从 observer 侧迁入）。
 */

/** 捕获「select 列 + where + limit + offset」的链式形状；返回 rows。 */
function stubSelectWithLimitOffset(rows: unknown[]) {
  const captured: { columns?: unknown; where?: unknown; limit?: unknown; offset?: unknown } = {};
  stubDb({
    select: (columns: unknown) => {
      captured.columns = columns;
      return {
        from: () => ({
          where: (condition: unknown) => {
            captured.where = condition;
            return {
              limit: (limit: unknown) => ({
                offset: (offset: unknown) => {
                  captured.limit = limit;
                  captured.offset = offset;
                  return Promise.resolve(rows);
                },
              }),
            };
          },
        }),
      };
    },
  });
  return captured;
}

/** 捕获「select 列 + where + limit」的链式形状（存在性判定不需要 offset）；返回 rows。 */
function stubSelectWithLimit(rows: unknown[]) {
  const captured: { columns?: unknown; where?: unknown; limit?: unknown } = {};
  stubDb({
    select: (columns: unknown) => {
      captured.columns = columns;
      return {
        from: () => ({
          where: (condition: unknown) => {
            captured.where = condition;
            return {
              limit: (limit: unknown) => {
                captured.limit = limit;
                return Promise.resolve(rows);
              },
            };
          },
        }),
      };
    },
  });
  return captured;
}

/** 捕获「update set + where」的链式形状。 */
function stubUpdate() {
  const captured: { values?: Record<string, unknown>; where?: unknown } = {};
  stubDb({
    update: () => ({
      set: (values: Record<string, unknown>) => {
        captured.values = values;
        return {
          where: (condition: unknown) => {
            captured.where = condition;
            return Promise.resolve(undefined);
          },
        };
      },
    }),
  });
  return captured;
}

describe("agent_config 跨包取数面", () => {
  beforeEach(() => {
    initializeAgentConfigModuleConfig();
  });

  afterEach(() => {
    resetAllStubs();
  });

  describe("searchAgentConfigsSystem（模型网关主体选择器）", () => {
    // 无条件检索：投影只有主体选择器渲染与回填要的四列，且不得凭空补 where。
    test("无过滤条件时只投影四列且不带 where", async () => {
      const captured = stubSelectWithLimitOffset([{ id: "agent-1" }]);

      const rows = await searchAgentConfigsSystem({ limit: 20, offset: 40 });

      expect(rows).toEqual([{ id: "agent-1" }]);
      expect(Object.keys(captured.columns as Record<string, unknown>)).toEqual([
        "id",
        "name",
        "organizationId",
        "userId",
      ]);
      expect(captured.where).toBeUndefined();
      expect(captured.limit).toBe(20);
      expect(captured.offset).toBe(40);
    });

    // 三个过滤条件各自下推成一列谓词：组织/用户是等值（ilike 无通配符），关键字是 name 或 id 的双向匹配。
    test("组织 / 用户 / 关键字各下推一列谓词并绑定调用方给的值", async () => {
      const captured = stubSelectWithLimitOffset([]);

      await searchAgentConfigsSystem({
        organizationId: "org-9",
        userId: "user-9",
        keyword: "  demo  ",
        limit: 10,
        offset: 0,
      });

      expect(collectColumnNames(captured.where).sort()).toEqual(["id", "name", "organization_id", "user_id"]);
      // 关键字两侧补 `%` 并以 trim 后的值为准：调用方传空白时不得生成 `%  %` 这种全匹配谓词。
      expect(collectParamValues(captured.where)).toEqual(["org-9", "user-9", "%demo%", "%demo%"]);
    });

    // 纯空白关键字等同于"没有输入过滤"：主体选择器清空输入框后不应把结果集收窄成空。
    test("关键字为纯空白时不生成名称条件", async () => {
      const captured = stubSelectWithLimitOffset([]);

      await searchAgentConfigsSystem({ keyword: "   ", limit: 5, offset: 0 });

      expect(captured.where).toBeUndefined();
    });
  });

  describe("isAgentConfigBoundToMachine（机器删除前的悬空引用守卫）", () => {
    // 命中一行即"仍被绑定"；判定只取 id 列，不需要把候选行交给 machine 包。
    test("存在绑定行时返回 true", async () => {
      const captured = stubSelectWithLimit(Array.from({ length: 3 }, (_, index) => ({ id: `agent-${index}` })));

      expect(await isAgentConfigBoundToMachine("org-1", "machine-1")).toBe(true);
      expect(Object.keys(captured.columns as Record<string, unknown>)).toEqual(["id"]);
      expect(collectColumnNames(captured.where).sort()).toEqual(["machine_id", "organization_id"]);
      expect(collectParamValues(captured.where)).toEqual(["org-1", "machine-1"]);
      // 存在性判定用 limit 1 而不是 count：这里钉住"不做全表计数"。
      expect(captured.limit).toBe(1);
    });

    // 无绑定行时放行删除；空数组与 null 行都必须判成"没有绑定"。
    test("无绑定行时返回 false", async () => {
      stubSelectWithLimit([]);

      expect(await isAgentConfigBoundToMachine("org-1", "machine-1")).toBe(false);
    });
  });

  describe("bindMachineIdByAgentName（机器注册路径的绑定写入口）", () => {
    // 机器上报的 agentName 是唯一身份线索：谓词落在「本组织 + 同名」上，且同步刷新 updatedAt。
    test("按组织与名称写入 machineId 并刷新 updatedAt", async () => {
      const captured = stubUpdate();

      await bindMachineIdByAgentName({ organizationId: "org-1", agentName: "demo-agent", machineId: "machine-1" });

      expect(captured.values?.machineId).toBe("machine-1");
      expect(captured.values?.updatedAt).toBeInstanceOf(Date);
      expect(Object.keys(captured.values ?? {}).sort()).toEqual(["machineId", "updatedAt"]);
      expect(collectColumnNames(captured.where).sort()).toEqual(["name", "organization_id"]);
      expect(collectParamValues(captured.where)).toEqual(["org-1", "demo-agent"]);
    });
  });
});
