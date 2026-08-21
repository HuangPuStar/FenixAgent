import { beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

// @ts-expect-error Bun query import 会加载独立的真实仓储实例，同时 ../db 仍由 preload stubDb Proxy 隔离。
const { environmentRepo } = await import("../repositories/environment?round69");

const NOW = new Date("2026-08-19T00:00:00.000Z");

function environmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "env-1",
    name: "研发环境",
    description: "用于验证",
    workspacePath: "/ignored/by-repository",
    agentConfigId: "agent-1",
    secret: "sec-test",
    machineName: "machine-1",
    branch: "main",
    gitRepoUrl: "https://example.invalid/repo.git",
    maxSessions: 2,
    workerType: "acp",
    capabilities: { terminal: true },
    status: "active",
    userId: "user-1",
    organizationId: "org-1",
    autoStart: true,
    lastPollAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function selected(rows: unknown[]) {
  const result = Object.assign(Promise.resolve(rows), { limit: () => result });
  return { from: () => ({ where: () => result }) };
}

function installDb(options: { selectRows?: unknown[][]; updateCount?: number } = {}) {
  const selectRows = [...(options.selectRows ?? [])];
  const calls = { inserted: [] as unknown[], updated: [] as unknown[] };

  stubDb({
    insert: () => ({
      values: (value: unknown) => {
        calls.inserted.push(value);
        return Promise.resolve();
      },
    }),
    select: () => selected(selectRows.shift() ?? []),
    update: () => ({
      set: (value: unknown) => {
        calls.updated.push(value);
        return { where: async () => ({ count: options.updateCount ?? 0 }) };
      },
    }),
  });

  return calls;
}

beforeEach(resetAllStubs);

describe("round69 environment repository 真实行为", () => {
  // 创建环境应写入调用方组织、默认值和可选字段。
  test("create 写入组织归属及默认持久化字段", async () => {
    const calls = installDb();

    const created = await environmentRepo.create({
      id: "env-created",
      userId: "user-owner",
      organizationId: "org-owner",
      name: "生产环境",
      capabilities: { browser: true },
    });

    expect(calls.inserted).toEqual([
      expect.objectContaining({
        id: "env-created",
        userId: "user-owner",
        organizationId: "org-owner",
        name: "生产环境",
        status: "active",
        workerType: "acp",
        maxSessions: 1,
        autoStart: true,
        capabilities: { browser: true },
      }),
    ]);
    expect(created).toMatchObject({
      id: "env-created",
      organizationId: "org-owner",
      workspacePath: "/tmp",
      maxSessions: 10,
    });
  });

  // 组织列表只能使用数据库在该组织范围内返回的记录，并重算隔离路径。
  test("listByOrganizationId 返回当前组织记录并重算 workspace 路径", async () => {
    installDb({ selectRows: [[environmentRow()]] });

    const records = await environmentRepo.listByOrganizationId("org-1");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "env-1",
      organizationId: "org-1",
      directory: `${process.cwd()}/workspaces/org-1/user-1/env-1`,
      workspacePath: `${process.cwd()}/workspaces/org-1/user-1/env-1`,
    });
  });

  // 指定组织与 agentConfig 的联合查询无匹配时不能泄露其他组织环境。
  test("findByAgentConfigId 跨组织未命中返回 undefined", async () => {
    installDb({ selectRows: [[]] });

    await expect(environmentRepo.findByAgentConfigId("org-other", "agent-1")).resolves.toBeUndefined();
  });

  // 更新只写入明确提供的字段，并以受影响行数报告结果。
  test("update 写入补丁字段并在命中记录时返回 true", async () => {
    const calls = installDb({ updateCount: 1 });
    const lastPollAt = new Date("2026-08-19T01:00:00.000Z");

    await expect(
      environmentRepo.update("env-1", { status: "offline", autoStart: false, lastPollAt, capabilities: null }),
    ).resolves.toBeTrue();

    expect(calls.updated).toEqual([
      expect.objectContaining({
        status: "offline",
        autoStart: false,
        lastPollAt,
        capabilities: null,
        updatedAt: expect.any(Date),
      }),
    ]);
  });

  // 未受影响行说明目标环境不存在，更新必须返回 false。
  test("update 未命中环境时返回 false", async () => {
    installDb({ updateCount: 0 });

    await expect(environmentRepo.update("missing", { name: "不会更新" })).resolves.toBeFalse();
  });
});
