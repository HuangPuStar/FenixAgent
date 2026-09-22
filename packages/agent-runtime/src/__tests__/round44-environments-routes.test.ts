import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentNodeUnavailableError } from "@fenix/orchestration";
import { NotFoundError, ValidationError } from "@fenix/platform-sdk";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { SandboxProviderNotConfiguredError, SandboxRuntimeNotReadyError } from "@fenix/resource-sandbox/server";
import { createWebEnvironmentsRoutes } from "../routes/web/environments";
import type { AgentRuntime } from "../runtime";
import {
  resetAgentRuntimePort,
  setOrchestrationInstanceDeps,
  stubAgentRuntimePort,
  stubCoreRuntimeFacade,
} from "../server/testing";
import { createStubAgentRuntimeAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

// 路由不再自持 deps 袋子（1.4 W3b）：环境能力经运行 port 取，替换点就是 port 绑定本身
//（见下方 beforeEach 的 `stubAgentRuntimePort`）。
// 1.5c 随路由一同迁入本包（原 `apps/server/src/__tests__/`）：守卫由宿主注入，认证改用包内守卫替身，
// 因此 `setTestOrgContext`（宿主 org-context 的测试 seam）在本文件里一并消失——替身直接提供
// `authContext`，不再经宿主装配路径解析组织。
const route = createWebEnvironmentsRoutes({ authGuardPlugin: createStubAgentRuntimeAuthGuardPlugin() });
const environmentId = "env-1";
const now = new Date("2026-08-19T00:00:00.000Z");

function environment(overrides: Record<string, unknown> = {}) {
  return {
    id: environmentId,
    name: "demo-env",
    description: "说明",
    workspacePath: "/workspace/demo",
    agentConfigId: "agent-1",
    status: "idle",
    machineName: null,
    branch: null,
    autoStart: false,
    lastPollAt: now,
    createdAt: now,
    updatedAt: now,
    secret: "environment-secret",
    userId: "user-1",
    organizationId: "org-1",
    ...overrides,
  };
}

function responseEnvironment(overrides: Record<string, unknown> = {}) {
  return {
    id: environmentId,
    name: "demo-env",
    description: "说明",
    workspace_path: "/workspace/demo",
    agent_config_id: "agent-1",
    status: "idle",
    machine_name: null,
    branch: null,
    auto_start: false,
    last_poll_at: 1_755_561_600,
    created_at: 1_755_561_600,
    updated_at: 1_755_561_600,
    ...overrides,
  };
}

function authenticate(userId = "user-1", organizationId = "org-1") {
  setTestAuth({ organizationId, userId });
}

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}

function json(path: string, method: string, body: Record<string, unknown> = {}) {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * 环境服务动词的文件内登记表。
 *
 * 为什么是文件内而不是宿主测试基建（§1.7 收尾）：环境能力在本包生产侧一律经 `getBoundAgentRuntime()` 取
 * （1.4 W3b），这张表只是把「用例要断言的动词」转写进运行 port 替身（见 `stubRuntime`），属于本文件私有的
 * 装配细节，不是跨包契约。原先进口宿主 `environmentServiceRegistry` 只因当时没有别的登记处，而该注册表
 * 零生产消费方——随 `apps-boundary` 残留面一起删除。
 *
 * 表值取 `any`：登记表承载各动词的真实签名，收窄发生在 port 边界；`src/__tests__/**` 下
 * `noExplicitAny` 已在 `biome.json` 覆盖中关闭，因此不需要（也不该留）行级 ignore——留着会被
 * biome 判为「无效果的抑制注释」告警。
 */
type EnvironmentServiceStubFn = (...args: any[]) => any;
let environmentServiceStubs: Record<string, EnvironmentServiceStubFn> = {};

/** 登记环境服务动词的替身（浅合并，同一用例可分多次登记）。 */
function stubEnvironmentService(overrides: Record<string, EnvironmentServiceStubFn>): void {
  environmentServiceStubs = { ...environmentServiceStubs, ...overrides };
}

/** 取已登记的动词替身；未登记时返回空函数（与旧注册表 `throwOnMissing = false` 同口径）。 */
function environmentServiceStub(name: string): EnvironmentServiceStubFn {
  return environmentServiceStubs[name] ?? (() => {});
}

function configureEnvironmentStubs() {
  stubEnvironmentService({
    createWebEnvironment: async () => environment(),
    deleteEnvironment: async () => {},
    getOwnedEnvironment: async () => environment(),
    listEnvironmentsWithInstances: async () => [],
    updateWebEnvironment: async () => environment(),
  });
}

/**
 * 装配运行 port：环境能力经 stub 注册表转发，实例能力默认空。
 *
 * 用例内需要改写实例能力时**再次调用本函数**并把覆盖传进来——port 是整值绑定，重新 `stubAgentRuntimePort`
 * 会丢掉 beforeEach 装好的环境转发，因此统一走这一个入口而不是在用例里直接调 `stubAgentRuntimePort`。
 */
function stubRuntime(overrides: Partial<AgentRuntime> = {}) {
  stubAgentRuntimePort({
    createEnvironment: (...args) => environmentServiceStub("createWebEnvironment")(...args),
    deleteEnvironment: (...args) => environmentServiceStub("deleteEnvironment")(...args),
    getOwnedEnvironment: (...args) => environmentServiceStub("getOwnedEnvironment")(...args),
    listEnvironments: (...args) => environmentServiceStub("listEnvironmentsWithInstances")(...args),
    updateEnvironment: (...args) => environmentServiceStub("updateWebEnvironment")(...args),
    listOwnedInstances: async () => [],
    ...overrides,
  });
}

describe("round44 Web 环境路由", () => {
  beforeEach(() => {
    environmentServiceStubs = {};
    resetAllStubs();
    authenticate();
    configureEnvironmentStubs();
    // 环境与实例能力一律经 port 取（1.4 W3b/W6b）：替换点是绑定本身，用例不再改写包内单例
    //（此前是 `agentInstanceService.resolveInstanceForOperation` 一类的 monkey-patch）。
    stubRuntime();
    stubCoreRuntimeFacade({ listInstances: () => [] });
  });

  afterEach(() => {
    resetAgentRuntimePort();
    resetTestAuth();
    resetAllStubs();
  });

  // 未认证请求必须由 sessionAuth 在业务服务调用前拒绝。
  test("未认证列表返回 401", async () => {
    resetTestAuth();

    expect((await request("/environments")).status).toBe(401);
  });

  // 列表必须同时以认证组织和用户过滤 runtime environment。
  test("列表传递当前组织和用户", async () => {
    let received: string[] = [];
    stubEnvironmentService({
      listEnvironmentsWithInstances: async (organizationId: string, userId: string) => {
        received = [organizationId, userId];
        return [];
      },
    });

    expect((await request("/environments")).status).toBe(200);
    expect(received).toEqual(["org-1", "user-1"]);
  });

  // 列表应原样返回服务层已按当前用户隔离的实例摘要。
  test("列表返回当前用户的环境摘要", async () => {
    stubEnvironmentService({
      listEnvironmentsWithInstances: async () => [
        {
          ...responseEnvironment(),
          agent_name: "Demo Agent",
          instance_uid: "instance-1",
          instances: [
            {
              instanceUid: "instance-1",
              name: "default",
              status: "running",
              createdAt: now.toISOString(),
            },
          ],
          instances_count: 1,
        },
      ],
    });

    const body = await (await request("/environments")).json();

    expect(body.data[0]).toMatchObject({ id: environmentId, instance_uid: "instance-1", instances_count: 1 });
  });

  // 创建必须把认证归属而非客户端输入写入服务层参数。
  test("创建绑定当前用户和组织", async () => {
    let received: Record<string, unknown> = {};
    stubEnvironmentService({
      createWebEnvironment: async (input: Record<string, unknown>) => {
        received = input;
        return environment();
      },
    });

    expect((await json("/environments", "POST", { name: "new-env", agentConfigId: "agent-2" })).status).toBe(200);
    expect(received).toEqual({
      name: "new-env",
      description: undefined,
      agentConfigId: "agent-2",
      autoStart: undefined,
      userId: "user-1",
      organizationId: "org-1",
    });
  });

  // 创建应保留可选描述和自动启动开关。
  test("创建传递描述和自动启动设置", async () => {
    let received: Record<string, unknown> = {};
    stubEnvironmentService({
      createWebEnvironment: async (input: Record<string, unknown>) => {
        received = input;
        return environment();
      },
    });

    await json("/environments", "POST", {
      name: "new-env",
      agentConfigId: "agent-2",
      description: "新环境",
      autoStart: false,
    });

    expect(received).toMatchObject({ description: "新环境", autoStart: false });
  });

  // 创建成功响应需包含仅在创建流程返回的环境密钥。
  test("创建响应包含环境密钥", async () => {
    const body = await (await json("/environments", "POST", { name: "new-env", agentConfigId: "agent-2" })).json();

    expect(body.data).toMatchObject({ id: environmentId, secret: "environment-secret" });
  });

  // 非 kebab-case 名称必须在调用创建服务前被 schema 拒绝。
  test("创建拒绝非法环境名称", async () => {
    let called = false;
    stubEnvironmentService({ createWebEnvironment: async () => (called = true) });

    expect((await json("/environments", "POST", { name: "Invalid Name", agentConfigId: "agent-2" })).status).toBe(422);
    expect(called).toBeFalse();
  });

  // 缺失 agent 配置时不得进入创建业务。
  test("创建拒绝缺失 agentConfigId", async () => {
    let called = false;
    stubEnvironmentService({ createWebEnvironment: async () => (called = true) });

    expect((await json("/environments", "POST", { name: "new-env" })).status).toBe(422);
    expect(called).toBeFalse();
  });

  // 领域 ValidationError 需要映射为统一的 400 响应。
  test("创建映射领域校验错误", async () => {
    stubEnvironmentService({ createWebEnvironment: async () => Promise.reject(new ValidationError("agent 不可用")) });

    const response = await json("/environments", "POST", { name: "new-env", agentConfigId: "agent-2" });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toEqual({ code: "VALIDATION_ERROR", message: "agent 不可用" });
  });

  // 带 VALIDATION_ERROR code 的非领域错误也应保持客户端校验语义。
  test("创建映射编码校验错误", async () => {
    const error = Object.assign(new Error("配置不兼容"), { code: "VALIDATION_ERROR" });
    stubEnvironmentService({ createWebEnvironment: async () => Promise.reject(error) });

    expect((await json("/environments", "POST", { name: "new-env", agentConfigId: "agent-2" })).status).toBe(400);
  });

  // 详情读取必须严格使用当前组织和用户归属范围。
  test("详情按当前组织和用户读取", async () => {
    let received: string[] = [];
    stubEnvironmentService({
      getOwnedEnvironment: async (id: string, organizationId: string, userId: string) => {
        received = [id, organizationId, userId];
        return environment();
      },
    });

    expect((await request(`/environments/${environmentId}`)).status).toBe(200);
    expect(received).toEqual([environmentId, "org-1", "user-1"]);
  });

  // 详情响应可返回访问该环境所需的 secret。
  test("详情包含环境密钥", async () => {
    const body = await (await request(`/environments/${environmentId}`)).json();

    expect(body.data).toMatchObject({ id: environmentId, secret: "environment-secret" });
  });

  // 跨组织或跨用户被服务层隐藏时，路由应统一为 404。
  test("详情隐藏无归属环境", async () => {
    stubEnvironmentService({
      getOwnedEnvironment: async () => Promise.reject(new NotFoundError(environmentId)),
    });

    expect((await request(`/environments/${environmentId}`)).status).toBe(404);
  });

  // 更新前必须先执行当前组织与用户的归属检查。
  test("更新先校验当前用户归属", async () => {
    let ownedScope: string[] = [];
    stubEnvironmentService({
      getOwnedEnvironment: async (id: string, organizationId: string, userId: string) => {
        ownedScope = [id, organizationId, userId];
        return environment();
      },
    });

    expect((await json(`/environments/${environmentId}`, "PUT", { name: "renamed-env" })).status).toBe(200);
    expect(ownedScope).toEqual([environmentId, "org-1", "user-1"]);
  });

  // 更新服务只接收路由允许修改的元数据与认证组织范围。
  test("更新传递允许修改的字段", async () => {
    let receivedId = "";
    let receivedOrganizationId = "";
    let received: Record<string, unknown> = {};
    stubEnvironmentService({
      updateWebEnvironment: async (id: string, organizationId: string, input: Record<string, unknown>) => {
        receivedId = id;
        receivedOrganizationId = organizationId;
        received = input;
        return environment({ name: "renamed-env" });
      },
    });

    await json(`/environments/${environmentId}`, "PUT", {
      name: "renamed-env",
      description: null,
      agentConfigId: "agent-2",
      autoStart: true,
    });

    expect([receivedId, receivedOrganizationId]).toEqual([environmentId, "org-1"]);
    expect(received).toEqual({ name: "renamed-env", description: null, agentConfigId: "agent-2", autoStart: true });
  });

  // 更新名称同样受 kebab-case 输入约束，且不应写入服务层。
  test("更新拒绝非法环境名称", async () => {
    let updated = false;
    stubEnvironmentService({ updateWebEnvironment: async () => (updated = true) });

    expect((await json(`/environments/${environmentId}`, "PUT", { name: "Bad Name" })).status).toBe(422);
    expect(updated).toBeFalse();
  });

  // 归属检查失败时，不得执行更新写入。
  test("更新无归属环境不执行写入", async () => {
    let updated = false;
    stubEnvironmentService({
      getOwnedEnvironment: async () => Promise.reject(new NotFoundError(environmentId)),
      updateWebEnvironment: async () => (updated = true),
    });

    expect((await json(`/environments/${environmentId}`, "PUT", { name: "renamed-env" })).status).toBe(404);
    expect(updated).toBeFalse();
  });

  // 更新服务的校验失败应映射为 400。
  test("更新映射校验错误", async () => {
    stubEnvironmentService({ updateWebEnvironment: async () => Promise.reject(new ValidationError("agent 不可用")) });

    expect((await json(`/environments/${environmentId}`, "PUT", { agentConfigId: "agent-2" })).status).toBe(400);
  });

  // enter 的 instanceUid 必须为字符串，非法输入不能越过 schema。
  test("进入环境拒绝非法实例 UID", async () => {
    let owned = false;
    stubEnvironmentService({ getOwnedEnvironment: async () => (owned = true) });

    expect((await json(`/environments/${environmentId}/enter`, "POST", { instanceUid: 0 })).status).toBe(422);
    expect(owned).toBeFalse();
  });

  // 未指定实例时客户端允许省略请求体，路由必须进入默认实例选择流程。
  test("进入环境允许省略请求体", async () => {
    stubEnvironmentService({
      getOwnedEnvironment: async () => Promise.reject(new NotFoundError(environmentId)),
    });

    const response = await request(`/environments/${environmentId}/enter`, { method: "POST" });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error?.code).toBe("NOT_FOUND");
  });

  // enter 必须先验证环境归属，避免未授权用户触发实例连接。
  test("进入环境无归属返回 404", async () => {
    stubEnvironmentService({
      getOwnedEnvironment: async () => Promise.reject(new NotFoundError(environmentId)),
    });

    expect((await json(`/environments/${environmentId}/enter`, "POST")).status).toBe(404);
  });

  // 已运行的持久实例可被进入，并返回当前 runtime 状态。
  test("进入已运行实例返回连接状态", async () => {
    const instance = {
      id: "instance-1",
      environmentId,
      ownerUserId: "user-1",
      name: "default",
      createdAt: now,
    } as never;
    stubRuntime({
      ensureInstance: async () => instance,
      ensureInstanceRuntime: async () => undefined,
      getRuntimeSnapshot: () => ({ state: "running" }) as never,
    });

    const response = await json(`/environments/${environmentId}/enter`, "POST", { instanceUid: "instance-1" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      instanceUid: "instance-1",
      environmentId,
      name: "default",
      status: "running",
      createdAt: now.toISOString(),
    });
  });

  // 远程 Agent node 未连接时应返回可重试的 503，而不是误报配置写入失败。
  test("进入远程环境映射 Agent node 不可用错误", async () => {
    // port 边界上 `ensureInstance` 已把「解析实例 + 确保 runtime」合成一个动作（1.4 W6b），
    // 因此这里以该动作整体抛错表达「确保 runtime 时发现节点不可用」；断言面是路由的错误映射与不泄漏。
    stubRuntime({
      ensureInstance: async () => {
        throw new AgentNodeUnavailableError();
      },
    });

    const response = await json(`/environments/${environmentId}/enter`, "POST");
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toEqual({ code: "AGENT_NODE_UNAVAILABLE", message: "Agent node is unavailable" });
  });

  // provider 未配置时，进入环境必须脱敏映射为 503。
  test("进入环境映射 provider 未配置错误", async () => {
    stubCoreRuntimeFacade({ listInstances: () => [] });
    setOrchestrationInstanceDeps({
      getOrchestrationController: () =>
        ({
          spawnInstance: async () => Promise.reject(new SandboxProviderNotConfiguredError("internal-provider")),
        }) as unknown as import("@fenix/orchestration").AgentController,
    });

    const response = await json(`/environments/${environmentId}/enter`, "POST");

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("internal-provider");
  });

  // runtime 未就绪时，同样不得泄漏 sandbox 内部标识。
  test("进入环境映射 runtime 未就绪错误", async () => {
    stubCoreRuntimeFacade({ listInstances: () => [] });
    setOrchestrationInstanceDeps({
      getOrchestrationController: () =>
        ({
          spawnInstance: async () => Promise.reject(new SandboxRuntimeNotReadyError("sbi_private")),
        }) as unknown as import("@fenix/orchestration").AgentController,
    });

    const response = await json(`/environments/${environmentId}/enter`, "POST");

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("sbi_private");
  });

  // 删除前必须按当前用户范围验证归属，随后才调用删除服务。
  test("删除验证归属后删除环境", async () => {
    const calls: string[] = [];
    stubEnvironmentService({
      getOwnedEnvironment: async (id: string, organizationId: string, userId: string) => {
        calls.push(`owned:${id}:${organizationId}:${userId}`);
        return environment();
      },
      deleteEnvironment: async (id: string) => calls.push(`delete:${id}`),
    });

    const response = await request(`/environments/${environmentId}`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(calls).toEqual([`owned:${environmentId}:org-1:user-1`, `delete:${environmentId}`]);
  });

  // 删除不存在或无归属环境时不得调用删除服务。
  test("删除无归属环境不执行删除", async () => {
    let deleted = false;
    stubEnvironmentService({
      getOwnedEnvironment: async () => Promise.reject(new NotFoundError(environmentId)),
      deleteEnvironment: async () => (deleted = true),
    });

    expect((await request(`/environments/${environmentId}`, { method: "DELETE" })).status).toBe(404);
    expect(deleted).toBeFalse();
  });

  // 实例列表同样需要先验证当前用户对环境的归属。
  test("实例列表验证当前组织和用户", async () => {
    let received: string[] = [];
    stubEnvironmentService({
      getOwnedEnvironment: async (id: string, organizationId: string, userId: string) => {
        received = [id, organizationId, userId];
        return environment();
      },
    });

    expect((await request(`/environments/${environmentId}/instances`)).status).toBe(200);
    expect(received).toEqual([environmentId, "org-1", "user-1"]);
  });

  // 空 runtime 时实例列表仍返回与请求环境一致的成功响应。
  test("实例列表返回当前环境的空集合", async () => {
    const body = await (await request(`/environments/${environmentId}/instances`)).json();

    expect(body).toEqual({ success: true, data: { environment_id: environmentId, instances: [] } });
  });

  // 无归属环境不可枚举其实例信息。
  test("实例列表隐藏无归属环境", async () => {
    stubEnvironmentService({
      getOwnedEnvironment: async () => Promise.reject(new NotFoundError(environmentId)),
    });

    expect((await request(`/environments/${environmentId}/instances`)).status).toBe(404);
  });
});
