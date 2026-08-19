/**
 * deleteEnvironment 删除前停止运行实例的测试（C-R2 修复验证）。
 *
 * 背景：删除 environment 只删 DB 行，其运行中的编排实例（进程 + 活跃表 + supplement
 * + 并发额度）会残留为资源泄漏（见 docs/issues/2026-08-19-agent-delete-instance-leak.md）。
 * 修复后 deleteEnvironment 在删 DB 前调用 stopInstancesForEnvironments，web DELETE 与
 * ACP（deregisterBridge / handleAcpDisconnect）路径自动继承。
 *
 * 注入方式（禁 mock.module，复用既有 seam）：
 *   - service 级直接 import environment-core 的真实 deleteEnvironment（该文件未被
 *     preload mock，barrel ../services/environment 才被 mock）；
 *   - core-bootstrap 经 stubCoreBootstrap 注入 fakeFacade，orchestration-instance 经
 *     setOrchestrationInstanceDeps 注入 fakeController 与 reclaimYjsDocs spy；
 *   - environmentRepo.delete 走真实实现 → db.delete → stubDb；
 *   - 路由级：web DELETE /environments/:id 从被 mock 的 barrel import deleteEnvironment，
 *     经 stubEnvironmentService 透传真实 deleteEnvironment 以端到端验证 stop 发生。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CoreRuntimeFacade } from "@fenix/core";
import type { AgentController } from "@fenix/orchestration";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { globalInstanceRegistry } from "../services/instance-registry";
import { resetOrchestrationInstanceDeps, setOrchestrationInstanceDeps } from "../services/orchestration-instance";
import {
  resetAllStubs,
  stubCoreBootstrap,
  stubDb,
  stubEnvironmentRepo,
  stubEnvironmentService,
} from "../test-utils/helpers";

const ORG_1 = "org-1";
const ENV_ID = "env-1";

/** 记录 facade.stopInstance 调用。 */
let stopCalls: string[] = [];
/** 编排域 fake controller 活跃表。 */
const fakeControllerInstances = new Set<string>();

/** core facade：无 core 快照，stopInstance 记录调用。 */
const fakeFacade = {
  listInstances: () => [],
  stopInstance: async (instanceId: string) => {
    stopCalls.push(instanceId);
  },
} as unknown as CoreRuntimeFacade;

/** 编排域 fake controller：listInstances 返回活跃表（带 environmentId），stopInstance 成功路径。 */
const fakeController = {
  listInstances: () => [...fakeControllerInstances].map((instanceId) => ({ instanceId, environmentId: ENV_ID })),
  stopInstance: async (instanceId: string) => {
    if (!fakeControllerInstances.has(instanceId)) throw new Error(`Instance '${instanceId}' not found`);
    fakeControllerInstances.delete(instanceId);
  },
} as unknown as AgentController;

/** 注册一个 running supplement（真实注册表单例）。 */
function registerRunningInstance(instanceId: string): void {
  globalInstanceRegistry.register(instanceId, {
    userId: "user-1",
    environmentId: ENV_ID,
    instanceNumber: 1,
    organizationId: ORG_1,
    spawnSource: "interactive",
    lastActivityAt: Date.now(),
    relayCount: 0,
    lastRelayDetachedAt: null,
  });
}

describe("deleteEnvironment 停止运行实例", () => {
  beforeEach(() => {
    resetAllStubs();
    globalInstanceRegistry.clear();
    fakeControllerInstances.clear();
    stopCalls = [];
    resetOrchestrationInstanceDeps();
    stubCoreBootstrap({ getCoreRuntime: () => fakeFacade });
    setOrchestrationInstanceDeps({
      getOrchestrationController: () => fakeController,
      reclaimYjsDocs: async () => {},
    });
    // ../repositories/environment 被 preload mock 为 Proxy，未配置时只有 getById；
    // environmentRepo.delete 需注入 stub（记录 DB 删除语义）
    stubEnvironmentRepo({ delete: async () => true });
  });

  afterEach(() => {
    globalInstanceRegistry.clear();
    fakeControllerInstances.clear();
    resetOrchestrationInstanceDeps();
    resetTestAuth();
    resetAllStubs();
  });

  // service 级：deleteEnvironment 先停止该 env 的 running 实例（三侧清理），再删 DB 行
  test("删除 environment 时停止其 running 实例后再删除 DB", async () => {
    registerRunningInstance("inst_1");
    fakeControllerInstances.add("inst_1");
    stubDb({ delete: () => ({ where: async () => ({ count: 1 }) }) });

    const { deleteEnvironment } = await import("../services/environment-core");
    const deleted = await deleteEnvironment(ENV_ID);

    expect(deleted).toBe(true);
    expect(globalInstanceRegistry.getByEnvironment(ENV_ID)).toEqual([]);
    expect(fakeControllerInstances.size).toBe(0);
    expect(stopCalls).toEqual(["inst_1"]);
  });

  // service 级：无运行实例时删除照常成功（helper 幂等 no-op），返回 true
  test("无运行实例时删除 environment 照常成功", async () => {
    stubDb({ delete: () => ({ where: async () => ({ count: 1 }) }) });

    const { deleteEnvironment } = await import("../services/environment-core");
    const deleted = await deleteEnvironment(ENV_ID);

    expect(deleted).toBe(true);
    expect(stopCalls).toEqual([]);
  });

  // 路由级：web DELETE /environments/:id 经 stubEnvironmentService 透传真实
  // deleteEnvironment，端到端验证 stop 发生且返回 200
  test("web DELETE /environments/:id 停止实例并返回 200", async () => {
    registerRunningInstance("inst_1");
    fakeControllerInstances.add("inst_1");
    stubDb({ delete: () => ({ where: async () => ({ count: 1 }) }) });
    const { deleteEnvironment } = await import("../services/environment-core");
    stubEnvironmentService({
      // route 经被 mock 的 barrel 调用 getOwnedEnvironment（权限校验）与 deleteEnvironment；
      // deleteEnvironment 透传真实实现以端到端验证 stop 链路
      getOwnedEnvironment: async () =>
        ({
          id: ENV_ID,
          organizationId: ORG_1,
          userId: "user-1",
          agentConfigId: "agc_1",
        }) as never,
      deleteEnvironment: (envId: string) => deleteEnvironment(envId),
    });
    setTestAuth({
      user: { id: "user-1", email: "user@fenix.com", name: "user" },
      authContext: { organizationId: ORG_1, userId: "user-1", role: "owner" },
    });

    const mod = await import("../routes/web/environments");
    const response = await mod.default.handle(
      new Request(`http://localhost/environments/${ENV_ID}`, { method: "DELETE" }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({ success: true, data: null });
    expect(globalInstanceRegistry.getByEnvironment(ENV_ID)).toEqual([]);
    expect(stopCalls).toEqual(["inst_1"]);
  });
});
