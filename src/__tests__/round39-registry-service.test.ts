import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AuthContext } from "../plugins/auth";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

// Bun 以独立模块实例加载真实服务实现，同时继续通过既有 stubDb Proxy 隔离所有数据库访问。
// @ts-expect-error Bun 支持带 query 的模块 specifier，TypeScript 无法解析。
const registry = await import("../services/registry?round39");

const owner: AuthContext = { organizationId: "org-a", userId: "user-a", role: "owner" };

function limitedRows(rows: unknown[]) {
  return { from: () => ({ where: () => ({ limit: async () => rows }) }) };
}

function orderedRows(rows: unknown[]) {
  return {
    from: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ offset: async () => rows }) }) }) }),
  };
}

function recentEvents(rows: unknown[]) {
  return { from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows }) }) }) };
}

function updateRecorder(writes: unknown[]) {
  return mock(() => ({ set: (value: unknown) => ({ where: async () => writes.push(value) }) }));
}

function insertRecorder(writes: unknown[], fail = false) {
  return mock(() => ({
    values: async (value: unknown) => {
      writes.push(value);
      if (fail) throw new Error("event storage unavailable");
    },
  }));
}

beforeEach(() => {
  resetAllStubs();
});

afterEach(() => {
  resetAllStubs();
});

describe("registry 服务第 39 轮真实业务覆盖", () => {
  // 默认列表应返回分页结果及独立的总数查询结果。
  test("默认列表返回机器数据和总数", async () => {
    const select = mock()
      .mockImplementationOnce(() => orderedRows([{ id: "mach-1" }]))
      .mockImplementationOnce(() => ({ from: () => ({ where: async () => [{ count: 3 }] }) }));
    stubDb({ select });

    await expect(registry.listMachines(owner, {})).resolves.toEqual({ data: [{ id: "mach-1" }], total: 3 });
    expect(select).toHaveBeenCalledTimes(2);
  });

  // 列表筛选不应影响组织范围内结果的返回结构。
  test("带状态、类型和标签的列表筛选返回查询结果", async () => {
    const select = mock()
      .mockImplementationOnce(() => orderedRows([{ id: "sandbox-1", status: "online" }]))
      .mockImplementationOnce(() => ({ from: () => ({ where: async () => [{ count: 1 }] }) }));
    stubDb({ select });

    await expect(
      registry.listMachines(owner, { status: "online", type: "sandbox", labels: ["gpu"], limit: 1, offset: 2 }),
    ).resolves.toEqual({ data: [{ id: "sandbox-1", status: "online" }], total: 1 });
  });

  // 可见机器详情必须附带按时间排序的近期事件。
  test("读取可见机器时附带近期事件", async () => {
    const select = mock()
      .mockImplementationOnce(() => limitedRows([{ id: "mach-1", organizationId: "org-a" }]))
      .mockImplementationOnce(() => recentEvents([{ type: "register" }]));
    stubDb({ select });

    await expect(registry.getMachine(owner, "mach-1")).resolves.toEqual({
      id: "mach-1",
      organizationId: "org-a",
      recentEvents: [{ type: "register" }],
    });
  });

  // 不可见或不存在的机器不得继续读取事件，避免泄露生命周期数据。
  test("读取不到机器时返回空且不查询事件", async () => {
    const select = mock(() => limitedRows([]));
    stubDb({ select });

    await expect(registry.getMachine(owner, "mach-hidden")).resolves.toBeNull();
    expect(select).toHaveBeenCalledTimes(1);
  });

  // 事件列表先校验机器可见性，未授权目标应表现为空分页。
  test("事件列表对不可见机器返回空分页", async () => {
    const select = mock(() => limitedRows([]));
    stubDb({ select });

    await expect(registry.listEvents(owner, "mach-hidden", { limit: 10, offset: 0 })).resolves.toEqual({
      data: [],
      total: 0,
    });
    expect(select).toHaveBeenCalledTimes(1);
  });

  // 可见机器的事件查询应同时返回分页数据与总数。
  test("事件列表返回事件数据和总数", async () => {
    const select = mock()
      .mockImplementationOnce(() => limitedRows([{ id: "mach-1" }]))
      .mockImplementationOnce(() => orderedRows([{ id: "evt-1", type: "disconnect" }]))
      .mockImplementationOnce(() => ({ from: () => ({ where: async () => [{ count: 7 }] }) }));
    stubDb({ select });

    await expect(registry.listEvents(owner, "mach-1", { limit: 5, offset: 5 })).resolves.toEqual({
      data: [{ id: "evt-1", type: "disconnect" }],
      total: 7,
    });
  });

  // 管理员预创建机器应写入 pending 状态和默认引擎。
  test("预创建机器使用默认引擎和待注册状态", async () => {
    const inserts: unknown[] = [];
    stubDb({ insert: insertRecorder(inserts) });

    const result = await registry.createMachine(owner, { name: "builder" });

    expect(result).toMatchObject({ name: "builder", status: "pending" });
    expect(result.initCommand).toContain(`RCS_MACHINE_ID=${result.id}`);
    expect(result.initCommand).toContain("AGENT_TYPE=opencode");
    expect(inserts).toEqual([expect.objectContaining({ agentName: "opencode", labels: [], status: "pending" })]);
  });

  // 自定义引擎和标签必须同时保留在机器记录与初始化命令中。
  test("预创建机器保留自定义引擎和标签", async () => {
    const inserts: unknown[] = [];
    stubDb({ insert: insertRecorder(inserts) });

    const result = await registry.createMachine(owner, { name: "runner", agentName: "claude-code", labels: ["ci"] });

    expect(result.initCommand).toContain("acp-runtime claude-code acp");
    expect(inserts).toEqual([expect.objectContaining({ agentName: "claude-code", labels: ["ci"] })]);
  });

  // Sandbox 身份应使用系统指定 id、类型和用户归属。
  test("预创建 sandbox 身份写入系统托管记录", async () => {
    const inserts: unknown[] = [];
    stubDb({ insert: insertRecorder(inserts) });

    await registry.createSandboxMachine({
      id: "mach-sandbox",
      organizationId: "org-a",
      userId: "user-a",
      agentName: "codex",
    });

    expect(inserts).toEqual([
      expect.objectContaining({
        id: "mach-sandbox",
        type: "sandbox",
        name: "mach-sandbox",
        userId: "user-a",
        status: "pending",
      }),
    ]);
  });

  // Sandbox 创建失败后的补偿路径只删除对应机器记录。
  test("删除 sandbox 身份执行补偿删除", async () => {
    const deleted: string[] = [];
    stubDb({ delete: mock(() => ({ where: async () => deleted.push("called") })) });

    await registry.deleteSandboxMachine("mach-sandbox");

    expect(deleted).toEqual(["called"]);
  });

  // 指定不存在的预创建 machineId 必须拒绝连接。
  test("指定不存在 machineId 时拒绝注册", async () => {
    stubDb({ select: mock(() => limitedRows([])) });

    await expect(
      registry.registerMachine({ agentName: "opencode", tenantId: "org-a", machineId: "missing" }),
    ).rejects.toThrow("not found");
  });

  // pending 机器的首次连接应激活机器、写 register 事件并绑定组织引擎。
  test("pending 机器首次注册后激活并绑定引擎", async () => {
    const updates: unknown[] = [];
    const inserts: unknown[] = [];
    stubDb({
      select: mock(() => limitedRows([{ id: "mach-new", status: "pending" }])),
      update: updateRecorder(updates),
      insert: insertRecorder(inserts),
    });

    await expect(
      registry.registerMachine({ agentName: "opencode", tenantId: "org-a", machineId: "mach-new" }),
    ).resolves.toEqual({
      id: "mach-new",
      isNew: true,
    });
    expect(updates).toContainEqual(expect.objectContaining({ status: "online", lastHeartbeatAt: expect.any(Date) }));
    expect(updates).toContainEqual(expect.objectContaining({ machineId: "mach-new" }));
    expect(inserts).toEqual([expect.objectContaining({ machineId: "mach-new", type: "register" })]);
  });

  // offline 机器重连必须保留非首次注册语义并写 reconnect 事件。
  test("offline 机器重连写 reconnect 事件", async () => {
    const inserts: unknown[] = [];
    stubDb({
      select: mock(() => limitedRows([{ id: "mach-offline", status: "offline" }])),
      update: updateRecorder([]),
      insert: insertRecorder(inserts),
    });

    await expect(
      registry.registerMachine({ agentName: "opencode", tenantId: null, machineId: "mach-offline" }),
    ).resolves.toEqual({
      id: "mach-offline",
      isNew: false,
    });
    expect(inserts).toEqual([expect.objectContaining({ machineId: "mach-offline", type: "reconnect" })]);
  });

  // 已标记 online 的陈旧记录允许重新建立连接。
  test("online 陈旧记录允许重连", async () => {
    stubDb({
      select: mock(() => limitedRows([{ id: "mach-stale", status: "online" }])),
      update: updateRecorder([]),
      insert: insertRecorder([]),
    });

    await expect(
      registry.registerMachine({ agentName: "opencode", tenantId: null, machineId: "mach-stale" }),
    ).resolves.toEqual({
      id: "mach-stale",
      isNew: false,
    });
  });

  // 未携带 machineId 时，可通过稳定 nodeId 找回已有机器。
  test("nodeId 命中已有机器时按重连处理", async () => {
    const inserts: unknown[] = [];
    stubDb({
      select: mock(() => limitedRows([{ id: "mach-node" }])),
      update: updateRecorder([]),
      insert: insertRecorder(inserts),
    });

    await expect(
      registry.registerMachine({ agentName: "codex", tenantId: null, nodeId: "mach-node" }),
    ).resolves.toEqual({
      id: "mach-node",
      isNew: false,
    });
    expect(inserts).toEqual([expect.objectContaining({ type: "reconnect" })]);
  });

  // 未命中的 nodeId 不能隐式创建机器，必须要求管理面预创建。
  test("nodeId 未命中时拒绝隐式注册", async () => {
    stubDb({ select: mock(() => limitedRows([])) });

    await expect(registry.registerMachine({ agentName: "codex", tenantId: null, nodeId: "unknown" })).rejects.toThrow(
      "admin panel",
    );
  });

  // 主动断开必须下线机器并保留调用方提供的原因。
  test("主动断开下线机器并记录原因", async () => {
    const updates: unknown[] = [];
    const inserts: unknown[] = [];
    stubDb({ update: updateRecorder(updates), insert: insertRecorder(inserts) });

    await registry.disconnectMachine("mach-1", "socket closed");

    expect(updates).toEqual([expect.objectContaining({ status: "offline" })]);
    expect(inserts).toEqual([expect.objectContaining({ type: "disconnect", detail: { reason: "socket closed" } })]);
  });

  // 心跳超时使用固定审计原因，区别于调用方主动断开。
  test("心跳超时下线机器并记录固定原因", async () => {
    const inserts: unknown[] = [];
    stubDb({ update: updateRecorder([]), insert: insertRecorder(inserts) });

    await registry.markHeartbeatTimeout("mach-1");

    expect(inserts).toEqual([
      expect.objectContaining({ type: "heartbeat_timeout", detail: { reason: "heartbeat timeout" } }),
    ]);
  });

  // 正常心跳只刷新时间戳，不改变连接状态或写入事件。
  test("正常心跳仅刷新存活时间", async () => {
    const updates: unknown[] = [];
    stubDb({ update: updateRecorder(updates) });

    await registry.updateHeartbeat("mach-1");

    expect(updates).toEqual([
      expect.objectContaining({ lastHeartbeatAt: expect.any(Date), updatedAt: expect.any(Date) }),
    ]);
  });

  // 通用事件入口应生成事件 id 并原样传递业务 detail。
  test("通用事件入口写入带前缀的事件记录", async () => {
    const inserts: unknown[] = [];
    stubDb({ insert: insertRecorder(inserts) });

    await registry.writeRegistryEvent("mach-1", "degraded", { reason: "disk full" });

    expect(inserts).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^evt_/),
        machineId: "mach-1",
        type: "degraded",
        detail: { reason: "disk full" },
      }),
    ]);
  });

  // 更新不存在或无权访问的机器必须失败，不能执行写入。
  test("更新不存在机器时拒绝操作", async () => {
    const update = updateRecorder([]);
    stubDb({ select: mock(() => limitedRows([])), update });

    await expect(registry.updateMachine(owner, "missing", { name: "new" })).rejects.toThrow("not found");
    expect(update).not.toHaveBeenCalled();
  });

  // 更新只应提交调用方明确提供的可修改字段。
  test("更新机器仅写入明确提供的标签", async () => {
    const updates: unknown[] = [];
    const select = mock()
      .mockImplementationOnce(() => limitedRows([{ id: "mach-1" }]))
      .mockImplementationOnce(() => limitedRows([{ id: "mach-1", labels: ["gpu"] }]));
    stubDb({ select, update: updateRecorder(updates) });

    await expect(registry.updateMachine(owner, "mach-1", { labels: ["gpu"] })).resolves.toEqual({
      id: "mach-1",
      labels: ["gpu"],
    });
    expect(updates).toEqual([expect.objectContaining({ labels: ["gpu"] })]);
    expect(updates[0]).not.toHaveProperty("name");
    expect(updates[0]).not.toHaveProperty("agentName");
  });

  // 删除不存在机器必须在引用查询及后置清理前终止。
  test("删除不存在机器时拒绝操作", async () => {
    const select = mock(() => limitedRows([]));
    stubDb({ select });

    await expect(registry.deleteMachine(owner, "missing")).rejects.toThrow("not found");
    expect(select).toHaveBeenCalledTimes(1);
  });

  // 在线机器具有活跃连接风险，不能由管理面删除。
  test("删除在线机器时拒绝操作", async () => {
    stubDb({ select: mock(() => limitedRows([{ id: "mach-live", status: "online" }])) });

    await expect(registry.deleteMachine(owner, "mach-live")).rejects.toThrow("online");
  });

  // 被 Agent 配置引用的机器不能删除，以避免留下悬空 machineId。
  test("删除被 Agent 配置引用的机器时拒绝操作", async () => {
    const select = mock()
      .mockImplementationOnce(() => limitedRows([{ id: "mach-ref", status: "offline" }]))
      .mockImplementationOnce(() => limitedRows([{ id: "agent-1" }]));
    stubDb({ select });

    await expect(registry.deleteMachine(owner, "mach-ref")).rejects.toThrow("agent configs");
  });

  // 组织默认引擎引用的机器不能删除，以保持组织默认配置完整。
  test("删除组织默认引擎引用的机器时拒绝操作", async () => {
    const select = mock()
      .mockImplementationOnce(() => limitedRows([{ id: "mach-default", status: "offline" }]))
      .mockImplementationOnce(() => limitedRows([]))
      .mockImplementationOnce(() => limitedRows([{ metadata: { defaultEngine: { machineId: "mach-default" } } }]));
    stubDb({ select });

    await expect(registry.deleteMachine(owner, "mach-default")).rejects.toThrow("default engine");
  });

  // 删除已成功时，即使退休事件归档失败，也必须保持删除成功的幂等结果。
  test("删除后退休事件失败不影响删除结果", async () => {
    const deleted: string[] = [];
    const select = mock()
      .mockImplementationOnce(() => limitedRows([{ id: "mach-retire", status: "offline" }]))
      .mockImplementationOnce(() => limitedRows([]))
      .mockImplementationOnce(() => limitedRows([{ metadata: null }]));
    stubDb({
      select,
      delete: mock(() => ({ where: async () => deleted.push("mach-retire") })),
      insert: insertRecorder([], true),
    });

    await expect(registry.deleteMachine(owner, "mach-retire")).resolves.toEqual({ deleted: true });
    expect(deleted).toEqual(["mach-retire"]);
  });

  // 服务重启清理应将所有 online 机器批量重置为 offline。
  test("服务重启时批量重置在线机器", async () => {
    const updates: unknown[] = [];
    stubDb({ update: updateRecorder(updates) });

    await registry.resetAllMachinesOffline();

    expect(updates).toEqual([expect.objectContaining({ status: "offline", updatedAt: expect.any(Date) })]);
  });
});
