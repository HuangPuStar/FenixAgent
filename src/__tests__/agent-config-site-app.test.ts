import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

/**
 * agent-config-site-app service：list / sync 行为
 *
 * 与 agent-config-skill / agent-config-mcp 的 service 测试结构对齐，覆盖：
 * - listAgentSiteAppIds 透传 SELECT 结果
 * - syncAgentSiteApps 全量覆盖（先删后插，空数组只删不插）
 */
describe("agent-config-site-app service", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  afterEach(() => {
    resetAllStubs();
  });

  test("listAgentSiteAppIds 返回绑定 siteAppId 数组", async () => {
    const whereMock = Promise.resolve([{ siteAppId: "site-1" }, { siteAppId: "site-2" }]);
    stubDb({
      select: () => ({
        from: () => ({
          where: () => whereMock,
        }),
      }),
    });
    const { listAgentSiteAppIds } = await import("../services/config/agent-config-site-app");
    const ids = await listAgentSiteAppIds("agent-cfg-1");
    expect(ids).toEqual(["site-1", "site-2"]);
  });

  test("syncAgentSiteApps 空数组只删不插", async () => {
    const deleteWhereFn = jestFn();
    stubDb({
      delete: () => ({
        where: deleteWhereFn,
      }),
      insert: () => {
        throw new Error("insert 不应被调用");
      },
    });
    const { syncAgentSiteApps } = await import("../services/config/agent-config-site-app");
    await syncAgentSiteApps("agent-cfg-1", []);
    expect(deleteWhereFn.calls).toHaveLength(1);
  });

  test("syncAgentSiteApps 非空数组先删后插，过滤空字符串", async () => {
    const deleteWhereFn = jestFn();
    const insertValues: unknown[] = [];
    stubDb({
      delete: () => ({
        where: deleteWhereFn,
      }),
      insert: () => ({
        values: (rows: unknown[]) => {
          insertValues.push(...rows);
          return Promise.resolve(undefined);
        },
      }),
    });
    const { syncAgentSiteApps } = await import("../services/config/agent-config-site-app");
    await syncAgentSiteApps("agent-cfg-1", ["site-1", "", "site-2"]);
    expect(deleteWhereFn.calls).toHaveLength(1);
    // 空字符串被过滤
    expect(insertValues).toEqual([
      { agentConfigId: "agent-cfg-1", siteAppId: "site-1" },
      { agentConfigId: "agent-cfg-1", siteAppId: "site-2" },
    ]);
  });
});

/** 极简 jest-like 函数 recorder，避免引入 jest 依赖 */
function jestFn() {
  const calls: unknown[][] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args);
  };
  fn.calls = calls;
  return fn as unknown as { (...args: unknown[]): void; calls: unknown[][] };
}
