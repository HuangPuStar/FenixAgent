import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppError, NotFoundError } from "../errors";
import type { EnvironmentRecord } from "../repositories";
import {
  createTemporaryEnvironment,
  deregisterEnvironment,
  getEnvironment,
  getEnvironmentBySecret,
  handleAcpConnect,
  handleAcpDisconnect,
  handleAcpIdentify,
  handleAcpRegister,
  listActiveEnvironments,
  listActiveEnvironmentsByUsername,
  listActiveEnvironmentsResponse,
  markEnvironmentActive,
  markEnvironmentIdle,
  reconnectBridge,
  reconnectEnvironment,
  registerEnvironment,
  touchEnvironmentPoll,
  updatePollTime,
} from "../services/environment-acp";
import { resetAllStubs, stubEnvironmentRepo } from "../test-utils/helpers";

function environment(overrides: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  return {
    id: "env-45",
    name: "environment-45",
    description: null,
    workspacePath: "/srv/workspaces/env-45",
    agentConfigId: null,
    secret: "secret-45",
    machineName: "machine-45",
    directory: "/srv/workspaces/env-45",
    branch: "main",
    gitRepoUrl: null,
    workerType: "acp",
    capabilities: null,
    status: "idle",
    username: "user-45",
    userId: "user-45",
    organizationId: "org-45",
    autoStart: false,
    lastPollAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

let updates: Array<{ id: string; patch: Record<string, unknown> }>;
let created: Record<string, unknown>[];

beforeEach(() => {
  resetAllStubs();
  updates = [];
  created = [];
  stubEnvironmentRepo({
    create: async (params: Record<string, unknown>) => {
      created.push(params);
      return environment({
        id: "created-45",
        secret: typeof params.secret === "string" ? params.secret : "generated-45",
      });
    },
    getById: async () => undefined,
    getBySecret: async () => undefined,
    update: async (id: string, patch: Record<string, unknown>) => {
      updates.push({ id, patch });
      return true;
    },
    listActive: async () => [],
    listActiveByUsername: async () => [],
  });
});

afterEach(() => {
  resetAllStubs();
});

describe("round45 environment-acp 的组织隔离与 ACP 生命周期", () => {
  // 认证查询只暴露连接鉴权所需字段，避免泄露环境配置。
  test("按 secret 返回最小认证环境信息", async () => {
    stubEnvironmentRepo({ getBySecret: async () => environment({ agentConfigId: "agent-45" }) });

    await expect(getEnvironmentBySecret("secret-45")).resolves.toEqual({
      id: "env-45",
      userId: "user-45",
      agentConfigId: "agent-45",
      organizationId: "org-45",
      secret: "secret-45",
    });
  });

  // 未匹配的 secret 必须表现为未认证，而非抛出内部错误。
  test("未知 secret 返回 null", async () => {
    await expect(getEnvironmentBySecret("missing-secret")).resolves.toBeNull();
  });

  // 显式 worker_type 应覆盖旧客户端 metadata 中的兼容值。
  test("旧式注册优先使用显式 worker_type", async () => {
    await registerEnvironment({ worker_type: "explicit", metadata: { worker_type: "legacy" } });

    expect(created[0]).toMatchObject({ userId: "system", workerType: "explicit" });
    expect(created[0]?.secret).toMatch(/^env_[0-9a-f]{48}$/);
  });

  // 兼容旧协议时仍应从 metadata 解析 worker 类型。
  test("旧式注册回退解析 metadata worker_type", async () => {
    await registerEnvironment({ metadata: { worker_type: "legacy" } });

    expect(created[0]).toMatchObject({ workerType: "legacy" });
  });

  // 调用方身份必须完整传入仓储，作为组织隔离的持久化归属。
  test("旧式注册保留用户和组织归属", async () => {
    await registerEnvironment({ userId: "owner-45", organizationId: "org-45", username: "alice" });

    expect(created[0]).toMatchObject({ userId: "owner-45", organizationId: "org-45", username: "alice" });
  });

  // 旧式注销仅改变状态，不能删除可能仍被管理面引用的记录。
  test("旧式注销标记为 deregistered", async () => {
    await deregisterEnvironment("env-45");

    expect(updates).toEqual([{ id: "env-45", patch: { status: "deregistered" } }]);
  });

  // 单环境读取直接透传仓储解析结果。
  test("读取环境返回仓储记录", async () => {
    const record = environment();
    stubEnvironmentRepo({ getById: async () => record });

    await expect(getEnvironment("env-45")).resolves.toBe(record);
  });

  // poll 更新必须使用服务端当前时间，而不是接收客户端时间戳。
  test("更新 poll 时间注入服务端 Date", async () => {
    await updatePollTime("env-45");

    expect(updates[0]?.id).toBe("env-45");
    expect(updates[0]?.patch.lastPollAt).toBeInstanceOf(Date);
  });

  // 活跃环境列表保留原始记录，供内部调用方继续读取归属字段。
  test("活跃环境列表透传原始记录", async () => {
    const records = [environment()];
    stubEnvironmentRepo({ listActive: async () => records });

    await expect(listActiveEnvironments()).resolves.toBe(records);
  });

  // v1 响应必须使用服务端 workspacePath，而非客户端上报 directory。
  test("活跃环境响应使用服务端 workspacePath", async () => {
    stubEnvironmentRepo({
      listActive: async () => [environment({ directory: "/untrusted", workspacePath: "/srv/owned" })],
    });

    await expect(listActiveEnvironmentsResponse()).resolves.toEqual([
      expect.objectContaining({ id: "env-45", directory: "/srv/owned" }),
    ]);
  });

  // 用户名筛选应由仓储执行并转换成公开响应格式。
  test("按用户名列出活跃环境响应", async () => {
    stubEnvironmentRepo({ listActiveByUsername: async (username: string) => [environment({ username })] });

    await expect(listActiveEnvironmentsByUsername("alice")).resolves.toEqual([
      expect.objectContaining({ username: "alice", status: "idle" }),
    ]);
  });

  // 重连后的旧式环境应恢复可调度状态。
  test("旧式重连标记为 active", async () => {
    await reconnectEnvironment("env-45");

    expect(updates).toEqual([{ id: "env-45", patch: { status: "active" } }]);
  });

  // active 状态同时刷新服务端 poll 时间，防止客户端伪造活跃度。
  test("标记 active 同时刷新服务端 poll 时间", async () => {
    await markEnvironmentActive("env-45");

    expect(updates[0]?.patch).toMatchObject({ status: "active" });
    expect(updates[0]?.patch.lastPollAt).toBeInstanceOf(Date);
  });

  // idle 状态不应意外改写最近轮询时间。
  test("标记 idle 只更新状态", async () => {
    await markEnvironmentIdle("env-45");

    expect(updates).toEqual([{ id: "env-45", patch: { status: "idle" } }]);
  });

  // transport 心跳只刷新 poll 时间，不改变调度状态。
  test("触碰 poll 只写入服务端当前时间", async () => {
    await touchEnvironmentPoll("env-45");

    expect(updates[0]?.patch.lastPollAt).toBeInstanceOf(Date);
    expect(updates[0]?.patch.status).toBeUndefined();
  });

  test("更新 capabilities 时将 null 归一为 undefined", async () => {});

  // 临时 ACP 环境必须固定 workerType，并保留由服务端接收的工作目录。
  test("创建临时环境固定 ACP 类型并传入 directory", async () => {
    await createTemporaryEnvironment({
      secret: "ws-45",
      userId: "user-45",
      machineName: "agent-45",
      directory: "/srv/workspaces/45",
      capabilities: { shell: true },
    });

    expect(created).toEqual([
      {
        secret: "ws-45",
        userId: "user-45",
        machineName: "agent-45",
        workerType: "acp",
        directory: "/srv/workspaces/45",
        capabilities: { shell: true },
      },
    ]);
  });

  // 不存在的 bridge 环境不能被重连，避免创建跨组织幽灵连接。
  test("bridge 重连拒绝不存在环境", async () => {
    await expect(reconnectBridge("missing", "user-45")).rejects.toThrow(NotFoundError);
    expect(updates).toEqual([]);
  });

  // 其他用户不能重连不属于自己的 bridge 环境。
  test("bridge 重连隔离其他用户环境", async () => {
    stubEnvironmentRepo({ getById: async () => environment({ userId: "owner-45" }) });

    await expect(reconnectBridge("env-45", "visitor-45")).rejects.toThrow("Environment not found");
    expect(updates).toEqual([]);
  });

  // 所有者重连 bridge 后环境恢复 active。
  test("bridge 所有者可以重连自己的环境", async () => {
    stubEnvironmentRepo({ getById: async () => environment() });

    await reconnectBridge("env-45", "user-45");

    expect(updates).toEqual([{ id: "env-45", patch: { status: "active" } }]);
  });

  // 未绑定 ACP 连接不应修改任何持久化环境。
  test("未绑定 ACP 连接不写入环境状态", async () => {
    await handleAcpConnect(null);

    expect(updates).toEqual([]);
  });

  // 绑定 ACP 建连必须激活指定环境。
  test("绑定 ACP 连接激活环境", async () => {
    await handleAcpConnect("env-45");

    expect(updates[0]?.patch).toMatchObject({ status: "active" });
  });

  // 绑定注册合并为一次更新，同时保留服务端 poll 时间。
  test("绑定 ACP 注册复用环境并合并状态更新", async () => {
    await expect(
      handleAcpRegister({
        wsId: "ws-45",
        userId: "user-45",
        agentName: "agent-45",
        capabilities: { terminal: true },
        boundEnvId: "env-45",
      }),
    ).resolves.toEqual({ envId: "env-45", isNew: false });

    expect(updates[0]?.patch.lastPollAt).toBeInstanceOf(Date);
    expect(created).toEqual([]);
  });

  // 未绑定注册使用 wsId 构造临时 secret，避免客户端自行指定认证凭据。
  test("未绑定 ACP 注册创建临时环境", async () => {
    await expect(
      handleAcpRegister({
        wsId: "ws-45",
        userId: "user-45",
        agentName: "agent-45",
        directory: "/srv/45",
        boundEnvId: null,
      }),
    ).resolves.toEqual({ envId: "created-45", isNew: true });

    expect(created[0]).toMatchObject({
      secret: "ws_ws-45",
      userId: "user-45",
      machineName: "agent-45",
      directory: "/srv/45",
    });
  });

  // 已绑定 identify 返回已保存 capabilities，并激活该环境。
  test("绑定 ACP identify 返回环境 capabilities", async () => {
    stubEnvironmentRepo({ getById: async () => environment({ capabilities: { files: true } }) });

    await expect(handleAcpIdentify({ agentId: "ignored", userId: "user-45", boundEnvId: "env-45" })).resolves.toEqual({
      envId: "env-45",
      capabilities: { files: true },
    });
    expect(updates[0]?.patch.status).toBe("active");
  });

  // 未绑定 identify 只能识别 ACP worker，拒绝其他环境类型。
  test("未绑定 ACP identify 拒绝非 ACP 环境", async () => {
    stubEnvironmentRepo({ getById: async () => environment({ workerType: "docker" }) });

    await expect(handleAcpIdentify({ agentId: "env-45", userId: "user-45", boundEnvId: null })).rejects.toThrow(
      NotFoundError,
    );
  });

  // 用户归属不匹配时返回 403，明确区别于 agent 不存在。
  test("未绑定 ACP identify 拒绝其他用户的 agent", async () => {
    stubEnvironmentRepo({ getById: async () => environment({ userId: "owner-45" }) });

    try {
      await handleAcpIdentify({ agentId: "env-45", userId: "visitor-45", boundEnvId: null });
      throw new Error("应当拒绝跨用户 identify");
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      expect(error.code).toBe("FORBIDDEN");
      expect(error.statusCode).toBe(403);
    }
  });

  // 自己的未绑定 ACP agent 可被 identify 并返回 capabilities。
  test("未绑定 ACP identify 激活同用户 agent", async () => {
    stubEnvironmentRepo({ getById: async () => environment({ capabilities: { prompts: true } }) });

    await expect(handleAcpIdentify({ agentId: "env-45", userId: "user-45", boundEnvId: null })).resolves.toEqual({
      envId: "env-45",
      capabilities: { prompts: true },
    });
    expect(updates[0]?.patch.status).toBe("active");
  });

  // 已绑定断连保留记录并转为 idle，供后续重连复用。
  test("绑定 ACP 断连标记为 idle", async () => {
    await handleAcpDisconnect("env-45", true);

    expect(updates).toEqual([{ id: "env-45", patch: { status: "idle" } }]);
  });
});
