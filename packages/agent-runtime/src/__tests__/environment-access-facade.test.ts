import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { environmentAccessFacade } from "../facades/environment-access-facade";
import type { EnvironmentRecord } from "../server/repositories/environment";
import { stubEnvironmentRepo } from "../server/testing";

/** 只填被测语义用得到的字段，其余按环境领域记录的形状补齐。 */
function environment(overrides: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  return {
    id: "env-1",
    name: "environment",
    description: null,
    workspacePath: "/workspace/env-1",
    agentConfigId: null,
    secret: "env-secret",
    machineName: null,
    directory: "/workspace/env-1",
    branch: null,
    gitRepoUrl: null,
    workerType: "local",
    capabilities: null,
    status: "ready",
    username: null,
    userId: "user-1",
    organizationId: "org-a",
    autoStart: false,
    lastPollAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe("EnvironmentAccessFacade 的组织隔离", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  afterEach(() => {
    resetAllStubs();
  });

  // 跨组织环境在严格归属读取下不可达：这是 YJS 会话端点拒绝别的组织连接所依赖的语义。
  test("非本组织的环境在严格归属读取下不可达", async () => {
    stubEnvironmentRepo({ getById: async () => environment({ organizationId: "org-b" }) });

    expect(await environmentAccessFacade.resolveOwnedEnvironment("env-1", "org-a", "user-1")).toBeUndefined();
  });

  // 同组织但不是环境属主时同样不可达：会话端点只服务环境本人，避免共享组织内的横向访问。
  test("同组织他人的环境不可达", async () => {
    stubEnvironmentRepo({ getById: async () => environment({ organizationId: "org-a", userId: "user-2" }) });

    expect(await environmentAccessFacade.resolveOwnedEnvironment("env-1", "org-a", "user-1")).toBeUndefined();
  });

  // 认证结果缺组织上下文（organizationId 为 null）时一律不可达，不退化到只比用户。
  test("缺少组织上下文时不可达", async () => {
    stubEnvironmentRepo({ getById: async () => environment({ organizationId: null, userId: "user-1" }) });

    expect(await environmentAccessFacade.resolveOwnedEnvironment("env-1", null, "user-1")).toBeUndefined();
  });

  // 组织与用户都一致时返回记录本身：可达分支必须真的带回读取结果，而不是只给布尔结论。
  test("组织与用户都一致时返回环境记录", async () => {
    stubEnvironmentRepo({ getById: async () => environment({ organizationId: "org-a", userId: "user-1" }) });

    expect(await environmentAccessFacade.resolveOwnedEnvironment("env-1", "org-a", "user-1")).toMatchObject({
      id: "env-1",
    });
  });

  // 控制面回查必须把「环境不存在」与「跨组织」分开回报：两者的对外响应文案不同，合并会改变线上行为。
  test("控制面回查区分环境不存在与跨组织", async () => {
    stubEnvironmentRepo({ getById: async () => undefined });
    expect(await environmentAccessFacade.resolveSessionEnvironment("env-1", "org-a")).toEqual({
      reachable: false,
      reason: "missing",
    });

    stubEnvironmentRepo({ getById: async () => environment({ organizationId: "org-b" }) });
    expect(await environmentAccessFacade.resolveSessionEnvironment("env-1", "org-a")).toEqual({
      reachable: false,
      reason: "other_organization",
    });
  });

  // 未挂组织的存量环境对控制面仍可达：用户维度已由持久实例归属校验覆盖，判成跨组织会让它无人可用。
  test("控制面回查容忍未挂组织的环境", async () => {
    stubEnvironmentRepo({ getById: async () => environment({ organizationId: null }) });

    expect(await environmentAccessFacade.resolveSessionEnvironment("env-1", "org-a")).toMatchObject({
      reachable: true,
    });
  });

  // ACP 列表只返回本组织的 acp worker：过滤与组织谓词都在门面内，路由不再自行拼装。
  test("ACP 环境列表按组织过滤且只含 acp worker", async () => {
    const scopes: string[] = [];
    stubEnvironmentRepo({
      listByOrganizationId: async (scope: string) => {
        scopes.push(scope);
        return [environment({ id: "env-acp", workerType: "acp" }), environment({ id: "env-local" })];
      },
    });

    const environments = await environmentAccessFacade.listAcpEnvironments("org-a", "user-1");

    expect(scopes).toEqual(["org-a"]);
    expect(environments.map((entry) => entry.id)).toEqual(["env-acp"]);
  });

  // 无组织上下文时归属键退化为用户标识：环境未挂组织时本就以 userId 归属，列表口径必须与之一致。
  test("无组织上下文的 ACP 列表以用户标识作归属键", async () => {
    const scopes: string[] = [];
    stubEnvironmentRepo({
      listByOrganizationId: async (scope: string) => {
        scopes.push(scope);
        return [environment({ workerType: "acp" })];
      },
    });

    await environmentAccessFacade.listAcpEnvironments(null, "user-1");

    expect(scopes).toEqual(["user-1"]);
  });
});
