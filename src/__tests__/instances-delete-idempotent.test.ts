/**
 * web DELETE /instances/:id 幂等语义测试（AE-P2.1）。
 *
 * 背景：stopInstance 原在调用 stopInstanceViaController 前先做 supplement /
 * controller 活跃表前置短路，二次 DELETE（三侧状态已清空）提前返回
 * "Instance not found" → route 映射 404，与"已停止 → 200"契约矛盾；
 * 同时 route 中 "Already stopped" 分支成为死代码。修复后 stopInstance 改为
 * 三侧状态收敛：任一存在即执行幂等停止，全无则返回 "Already stopped"，
 * 由 route 统一映射 200。
 *
 * 注入方式（禁 mock.module，复用既有 seam）：
 *   - globalInstanceRegistry 为真实单例，beforeEach 清空、用例内注册 supplement；
 *   - core-bootstrap 通过 stubCoreBootstrap 注入 fakeFacade（listInstances 空 +
 *     记录 stopInstance / deleteInstance 调用）；
 *   - orchestration-instance 通过 setOrchestrationInstanceDeps 注入 fakeController
 *     （活跃表可操控，模拟"活跃实例正常停止"的成功路径）；未注入的用例走真实
 *     controller 单例（活跃表为空，controller.stopInstance 抛 INSTANCE_NOT_FOUND
 *     被 stopInstanceViaController 吞错——预期日志，不改）；
 *   - auth 通过 setTestAuth 注入，路由直接 handle(Request)。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CoreRuntimeFacade } from "@fenix/core";
import type { AgentController } from "@fenix/orchestration";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { globalInstanceRegistry } from "../services/instance-registry";
import { resetOrchestrationBootstrap } from "../services/orchestration-bootstrap";
import { resetOrchestrationInstanceDeps, setOrchestrationInstanceDeps } from "../services/orchestration-instance";
import { resetAllStubs, stubCoreBootstrap, stubDb } from "../test-utils/helpers";

const ORG_1 = "org-1";
const ORG_2 = "org-2";

/** 记录 facade.stopInstance 调用。 */
const stopCalls: string[] = [];
/** 记录 facade.deleteInstance 调用。 */
const deleteCalls: string[] = [];

/** core facade：listInstances 恒为空（模拟已停止/无痕实例），停止与删除记录调用。 */
const fakeFacade = {
  listInstances: () => [],
  stopInstance: async (instanceId: string) => {
    stopCalls.push(instanceId);
  },
  deleteInstance: (instanceId: string) => {
    deleteCalls.push(instanceId);
    return true;
  },
} as unknown as CoreRuntimeFacade;

/** 编排域 fake controller：活跃表可操控，stopInstance 成功路径（无 INSTANCE_NOT_FOUND 吞错）。 */
const fakeControllerInstances = new Set<string>();
const fakeController = {
  listInstances: () => [...fakeControllerInstances].map((instanceId) => ({ instanceId })),
  stopInstance: async (instanceId: string) => {
    if (!fakeControllerInstances.has(instanceId)) {
      throw new Error(`Instance '${instanceId}' not found`);
    }
    fakeControllerInstances.delete(instanceId);
  },
} as unknown as AgentController;

/** 注册一个属于指定 org 的 running supplement（真实注册表单例）。 */
function registerRunningInstance(instanceId: string, environmentId: string, organizationId: string): void {
  globalInstanceRegistry.register(instanceId, {
    userId: "user-1",
    environmentId,
    organizationId,
    spawnSource: "system",
    lastActivityAt: Date.now(),
    relayCount: 0,
    lastRelayDetachedAt: null,
  });
}

describe("DELETE /web/instances/:id", () => {
  beforeEach(() => {
    globalInstanceRegistry.clear();
    fakeControllerInstances.clear();
    resetAllStubs();
    resetOrchestrationBootstrap();
    resetOrchestrationInstanceDeps();
    stubDb({});
    stubCoreBootstrap({ getCoreRuntime: () => fakeFacade });
    setTestAuth({
      user: { id: "user-1", email: "user@fenix.com", name: "user" },
      authContext: { organizationId: ORG_1, userId: "user-1", role: "owner" },
    });
    stopCalls.length = 0;
    deleteCalls.length = 0;
  });

  afterEach(() => {
    globalInstanceRegistry.clear();
    fakeControllerInstances.clear();
    resetTestAuth();
    resetAllStubs();
    resetOrchestrationBootstrap();
    resetOrchestrationInstanceDeps();
  });

  // 首次 DELETE 活跃实例：走 stopInstanceViaController 成功路径，返回 200 且
  // supplement 被清理、core stop / delete 均被调用（route ok 分支保留 deleteInstance 兜底）
  test("首次 DELETE 停止活跃实例返回 200 并清理 supplement", async () => {
    setOrchestrationInstanceDeps({ getOrchestrationController: () => fakeController });
    registerRunningInstance("inst_1", "env-1", ORG_1);
    fakeControllerInstances.add("inst_1");

    const mod = await import("../routes/web/instances");
    const response = await mod.default.handle(new Request("http://localhost/instances/inst_1", { method: "DELETE" }));

    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Agent Instance not found" },
    });
    expect(globalInstanceRegistry.get("inst_1")).toBeDefined();
    expect(stopCalls).toEqual([]);
    expect(deleteCalls).toEqual([]);
  });

  // 验收点 18：连续两次 DELETE 均返回 200——第二次三侧状态全无，走
  // "Already stopped" 幂等终态分支，不再 404，也不再触发 deleteInstance 清理
  test("连续两次 DELETE 均返回 200（第二次不再 404）", async () => {
    setOrchestrationInstanceDeps({ getOrchestrationController: () => fakeController });
    registerRunningInstance("inst_2", "env-1", ORG_1);
    fakeControllerInstances.add("inst_2");

    const mod = await import("../routes/web/instances");
    const first = await mod.default.handle(new Request("http://localhost/instances/inst_2", { method: "DELETE" }));
    const second = await mod.default.handle(new Request("http://localhost/instances/inst_2", { method: "DELETE" }));

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect((await second.json()) as unknown).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Agent Instance not found" },
    });
    expect(globalInstanceRegistry.get("inst_2")).toBeDefined();
    expect(deleteCalls).toEqual([]);
  });

  // 从未存在/已无痕的实例：无 supplement、活跃表空、core 空 → 幂等终态 200，
  // 且不触碰 facade（stopInstance / deleteInstance 均不被调用）
  test("对从未存在或已无痕的实例 DELETE 返回 200 而非 404", async () => {
    const mod = await import("../routes/web/instances");
    const response = await mod.default.handle(
      new Request("http://localhost/instances/inst_ghost", { method: "DELETE" }),
    );

    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Agent Instance not found" },
    });
    expect(stopCalls).toEqual([]);
    expect(deleteCalls).toEqual([]);
  });

  // 多租户隔离：跨组织 DELETE 被 stopInstance 的归属校验拦截，返回 403，
  // 实例保持存活、facade 无任何停止调用
  test("跨组织 DELETE 返回 403 且实例保持存活", async () => {
    registerRunningInstance("inst_4", "env-1", ORG_1);
    setTestAuth({
      user: { id: "user-2", email: "user2@fenix.com", name: "user2" },
      authContext: { organizationId: ORG_2, userId: "user-2", role: "member" },
    });

    const mod = await import("../routes/web/instances");
    const response = await mod.default.handle(new Request("http://localhost/instances/inst_4", { method: "DELETE" }));

    expect(response.status).toBe(404);
    const body = (await response.json()) as { success: false; error: { code: string; message: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(globalInstanceRegistry.get("inst_4")).toBeDefined();
    expect(stopCalls).toEqual([]);
  });

  // 状态分裂兜底：supplement 残留但编排域活跃表无记录（如 workflow cleanup 跳过
  // 的孤儿实例）→ 收敛停止并清理 supplement，返回 200；controller 抛
  // INSTANCE_NOT_FOUND 被 stopInstanceViaController 吞错（预期 error 日志，不改）
  test("supplement 残留（活跃表无记录）时 DELETE 收敛清理", async () => {
    registerRunningInstance("inst_5", "env-1", ORG_1);

    const mod = await import("../routes/web/instances");
    const response = await mod.default.handle(new Request("http://localhost/instances/inst_5", { method: "DELETE" }));

    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Agent Instance not found" },
    });
    expect(globalInstanceRegistry.get("inst_5")).toBeDefined();
    expect(stopCalls).toEqual([]);
  });
});
