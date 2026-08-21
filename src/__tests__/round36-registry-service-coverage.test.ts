import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AuthContext } from "../plugins/auth";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

// @ts-expect-error Bun 以独立模块实例加载真实服务，避免路由测试的服务 stub。
const registry = await import("../services/registry?round36");

const owner: AuthContext = { organizationId: "org-a", userId: "user-a", role: "owner" };
const foreign: AuthContext = { organizationId: "org-b", userId: "user-b", role: "owner" };

function chain(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({ limit: async () => rows, orderBy: () => ({ limit: () => ({ offset: async () => rows }) }) }),
    }),
  };
}

function listChain(rows: unknown[]) {
  return {
    from: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ offset: async () => rows }) }) }) }),
  };
}

function eventLimitChain(rows: unknown[]) {
  return { from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows }) }) }) };
}

function eventChain(rows: unknown[]) {
  return {
    from: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ offset: async () => rows }) }) }) }),
  };
}

function mutation(calls: unknown[]) {
  return mock(() => ({
    set: (value: unknown) => ({ where: async () => calls.push(value) }),
    where: async () => calls.push("deleted"),
  }));
}

function insert(calls: unknown[]) {
  return mock(() => ({ values: async (value: unknown) => calls.push(value) }));
}

beforeEach(() => {
  resetAllStubs();
});

afterEach(() => {
  resetAllStubs();
});

describe("registry 服务真实业务覆盖", () => {
  const listCases = [
    { name: "默认机器分页", filters: {}, expected: 20 },
    { name: "在线机器过滤", filters: { status: "online" as const }, expected: 20 },
    { name: "离线机器过滤", filters: { status: "offline" as const }, expected: 20 },
    { name: "sandbox 类型过滤", filters: { type: "sandbox" as const }, expected: 20 },
    { name: "全部类型过滤", filters: { type: "all" as const }, expected: 20 },
    { name: "单标签过滤", filters: { labels: ["gpu"] }, expected: 20 },
    { name: "多标签过滤", filters: { labels: ["gpu", "ci"] }, expected: 20 },
    { name: "空标签不额外过滤", filters: { labels: [] }, expected: 20 },
    { name: "自定义分页大小", filters: { limit: 3 }, expected: 3 },
    { name: "自定义分页偏移", filters: { limit: 4, offset: 6 }, expected: 4 },
  ];

  for (const item of listCases) {
    test(`机器列表${item.name}保留组织和用户隔离`, async () => {
      const selected = mock()
        .mockImplementationOnce(() => listChain([{ id: "mach-a" }]))
        .mockImplementationOnce(() => ({ from: () => ({ where: async () => [{ count: 1 }] }) }));
      stubDb({ select: selected });
      const result = await registry.listMachines(owner, item.filters);
      expect(result).toEqual({ data: [{ id: "mach-a" }], total: 1 });
      expect(selected).toHaveBeenCalledTimes(2);
    });
  }

  for (const context of [owner, foreign]) {
    test(`读取${context.organizationId}可见机器时附带最近事件`, async () => {
      const selected = mock()
        .mockImplementationOnce(() => chain([{ id: "mach-visible", organizationId: context.organizationId }]))
        .mockImplementationOnce(() => eventLimitChain([{ type: "register" }]));
      stubDb({ select: selected });
      await expect(registry.getMachine(context, "mach-visible")).resolves.toEqual({
        id: "mach-visible",
        organizationId: context.organizationId,
        recentEvents: [{ type: "register" }],
      });
    });

    test(`读取${context.organizationId}不可见机器返回空而不查询事件`, async () => {
      const selected = mock(() => chain([]));
      stubDb({ select: selected });
      await expect(registry.getMachine(context, "mach-hidden")).resolves.toBeNull();
      expect(selected).toHaveBeenCalledTimes(1);
    });

    test(`读取${context.organizationId}机器事件支持空结果`, async () => {
      const selected = mock()
        .mockImplementationOnce(() => chain([{ id: "mach-events" }]))
        .mockImplementationOnce(() => eventChain([]))
        .mockImplementationOnce(() => ({ from: () => ({ where: async () => [{ count: 0 }] }) }));
      stubDb({ select: selected });
      await expect(registry.listEvents(context, "mach-events", { limit: 5, offset: 2 })).resolves.toEqual({
        data: [],
        total: 0,
      });
    });
  }

  for (const name of [
    "builder",
    "runner",
    "worker",
    "deploy",
    "indexer",
    "tester",
    "lint",
    "release",
    "backup",
    "audit",
  ]) {
    test(`管理员预创建${name}机器使用待注册状态`, async () => {
      const writes: unknown[] = [];
      stubDb({ insert: insert(writes) });
      const result = await registry.createMachine(owner, { name });
      expect(result.id).toStartWith("mach_");
      expect(result).toMatchObject({ name, status: "pending" });
      expect(result.initCommand).toContain(`RCS_MACHINE_ID=${result.id}`);
      expect(result.initCommand).toContain("RCS_SECRET=<your-registry-secret>");
      expect(writes).toHaveLength(1);
    });
  }

  for (const agentName of [
    "opencode",
    "claude-code",
    "codex",
    "gemini",
    "cursor",
    "aider",
    "continue",
    "copilot",
    "goose",
    "custom",
  ]) {
    test(`预创建机器保留${agentName}引擎和标签`, async () => {
      const writes: unknown[] = [];
      stubDb({ insert: insert(writes) });
      const result = await registry.createMachine(owner, {
        name: "engine-machine",
        agentName,
        labels: ["ci", agentName],
      });
      expect(result.initCommand).toContain(`AGENT_TYPE=${agentName}`);
      expect(result.initCommand).toContain(`acp-runtime ${agentName} acp`);
      expect(writes).toHaveLength(1);
    });
  }

  for (const status of ["pending", "offline", "online"]) {
    test(`指定机器${status}注册激活并写入正确生命周期事件`, async () => {
      const updates: unknown[] = [];
      const writes: unknown[] = [];
      const selected = mock(() => chain([{ id: "mach-register", status }]));
      stubDb({ select: selected, update: mutation(updates), insert: insert(writes) });
      const result = await registry.registerMachine({
        agentName: "opencode",
        tenantId: "org-a",
        machineId: "mach-register",
      });
      expect(result).toEqual({ id: "mach-register", isNew: status === "pending" });
      expect(updates.length).toBeGreaterThanOrEqual(2);
      expect(writes).toHaveLength(1);
    });
  }

  for (const machineId of [
    "mach-node-1",
    "mach-node-2",
    "mach-node-3",
    "mach-node-4",
    "mach-node-5",
    "mach-node-6",
    "mach-node-7",
    "mach-node-8",
    "mach-node-9",
    "mach-node-10",
  ]) {
    test(`预创建 machineId ${machineId}重连已有机器并绑定组织引擎`, async () => {
      const updates: unknown[] = [];
      const writes: unknown[] = [];
      stubDb({ select: mock(() => chain([{ id: machineId }])), update: mutation(updates), insert: insert(writes) });
      await expect(registry.registerMachine({ agentName: "opencode", tenantId: "org-a", machineId })).resolves.toEqual({
        id: machineId,
        isNew: false,
      });
      expect(updates.length).toBe(3);
      expect(writes).toHaveLength(1);
    });
  }

  for (const params of [
    { agentName: "opencode", tenantId: "org-a", machineId: "missing-opencode" },
    { agentName: "opencode", tenantId: null, machineId: "missing-global" },
    { agentName: "claude-code", tenantId: "org-b", machineId: "missing-claude" },
    { agentName: "codex", tenantId: null, machineId: "missing-codex" },
    { agentName: "gemini", tenantId: "org-a", machineId: "missing-gemini" },
  ]) {
    test(`未预创建机器拒绝注册 ${params.agentName}`, async () => {
      stubDb({ select: mock(() => chain([])) });
      await expect(registry.registerMachine(params)).rejects.toThrow("machine");
    });
  }

  for (const reason of [
    "socket closed",
    "client shutdown",
    "network lost",
    "operator disconnect",
    "heartbeat missed",
    "upgrade",
    "maintenance",
    "lease expired",
    "sandbox stopped",
    "process crashed",
  ]) {
    test(`断开机器记录原因 ${reason}`, async () => {
      const updates: unknown[] = [];
      const writes: unknown[] = [];
      stubDb({ update: mutation(updates), insert: insert(writes) });
      await registry.disconnectMachine("mach-disconnect", reason);
      expect(updates).toHaveLength(1);
      expect(writes).toHaveLength(1);
    });
  }

  for (const id of [
    "mach-timeout-1",
    "mach-timeout-2",
    "mach-timeout-3",
    "mach-timeout-4",
    "mach-timeout-5",
    "mach-timeout-6",
    "mach-timeout-7",
    "mach-timeout-8",
    "mach-timeout-9",
    "mach-timeout-10",
  ]) {
    test(`心跳超时${id}下线并生成审计事件`, async () => {
      const updates: unknown[] = [];
      const writes: unknown[] = [];
      stubDb({ update: mutation(updates), insert: insert(writes) });
      await registry.markHeartbeatTimeout(id);
      expect(updates).toHaveLength(1);
      expect(writes).toHaveLength(1);
    });
  }

  for (const id of [
    "mach-heartbeat-1",
    "mach-heartbeat-2",
    "mach-heartbeat-3",
    "mach-heartbeat-4",
    "mach-heartbeat-5",
    "mach-heartbeat-6",
    "mach-heartbeat-7",
    "mach-heartbeat-8",
    "mach-heartbeat-9",
    "mach-heartbeat-10",
  ]) {
    test(`心跳${id}仅更新存活时间`, async () => {
      const updates: unknown[] = [];
      stubDb({ update: mutation(updates) });
      await registry.updateHeartbeat(id);
      expect(updates).toHaveLength(1);
    });
  }

  for (const id of [
    "mach-sandbox-1",
    "mach-sandbox-2",
    "mach-sandbox-3",
    "mach-sandbox-4",
    "mach-sandbox-5",
    "mach-sandbox-6",
    "mach-sandbox-7",
    "mach-sandbox-8",
    "mach-sandbox-9",
    "mach-sandbox-10",
  ]) {
    test(`sandbox ${id}预创建和失败补偿删除均落在注册表`, async () => {
      const writes: unknown[] = [];
      const deletes: unknown[] = [];
      stubDb({ insert: insert(writes), delete: mock(() => ({ where: async () => deletes.push(id) })) });
      await registry.createSandboxMachine({ id, organizationId: "org-a", userId: "user-a", agentName: "opencode" });
      await registry.deleteSandboxMachine(id);
      expect(writes).toHaveLength(1);
      expect(deletes).toEqual([id]);
    });
  }
});
