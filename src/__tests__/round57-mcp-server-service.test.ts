import { beforeEach, describe, expect, test } from "bun:test";
import type { AuthContext } from "../plugins/auth";
import {
  assertMcpServerInternalWritable,
  assertMcpServerInternalWritableById,
  countToolsByServer,
  createMcpServer,
  deleteMcpServer,
  deleteMcpServerById,
  deleteToolsByServer,
  getMcpServer,
  getMcpServerById,
  getMcpServerByResourceKey,
  isValidMcpName,
  listMcpServers,
  listToolsByServer,
  replaceToolsForServer,
  setMcpServerEnabled,
  toServerInfo,
  updateMcpServer,
  updateMcpServerById,
  validateMcpConfig,
} from "../services/config/mcp-server";
import { _resetDeps, setOrganizationRepoForTesting } from "../services/resource-permission";
import { resetAllStubs, stubDb, stubResourcePermissionRepo } from "../test-utils/helpers";

const ctx: AuthContext = { organizationId: "org_current", userId: "user_owner", role: "owner" };
const date = new Date("2026-08-19T00:00:00.000Z");

type McpRow = {
  id: string;
  userId: string;
  organizationId: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function row(overrides: Partial<McpRow> = {}): McpRow {
  return {
    id: "mcp-1",
    userId: "user_owner",
    organizationId: "org_current",
    name: "shared-server",
    type: "remote",
    config: { type: "remote", url: "https://mcp.example.test" },
    enabled: true,
    createdAt: date,
    updatedAt: date,
    ...overrides,
  };
}

function result<T>(rows: T[]) {
  return Object.assign(Promise.resolve(rows), { limit: async () => rows });
}

function installSelect(rows: unknown[][]) {
  stubDb({
    select: () => ({ from: () => ({ where: () => result(rows.shift() ?? []) }) }),
  });
}

function installMutation(options: { update?: unknown[]; delete?: unknown[]; insert?: string } = {}) {
  stubDb({
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({ returning: async () => [{ id: options.insert ?? "mcp-created" }] }),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => options.update ?? [{ id: "mcp-updated" }] }) }),
    }),
    delete: () => ({ where: () => ({ returning: async () => options.delete ?? [{ id: "mcp-deleted" }] }) }),
  });
}

beforeEach(() => {
  resetAllStubs();
  _resetDeps();
  setOrganizationRepoForTesting({ listNamesByIds: async () => new Map([["org_current", "Current"]]) });
  stubResourcePermissionRepo({
    listOwnedByOrganization: async () => [],
    listAccessibleForPrincipal: async () => [],
    canReadExternalResource: async () => false,
  });
});

describe("round57 MCP server service", () => {
  // 名称允许单字符、数字和单个连字符分隔的合法形式。
  test("合法名称边界", () => {
    expect(isValidMcpName("a")).toBe(true);
    expect(isValidMcpName("9-server")).toBe(true);
    expect(isValidMcpName("a".repeat(64))).toBe(true);
  });

  // 名称不能为空、超长、使用大写或以连字符开头结尾。
  test("非法名称边界", () => {
    expect(isValidMcpName("")).toBe(false);
    expect(isValidMcpName("a".repeat(65))).toBe(false);
    expect(isValidMcpName("Server")).toBe(false);
    expect(isValidMcpName("-server")).toBe(false);
    expect(isValidMcpName("server-")).toBe(false);
  });

  // 连续连字符会破坏名称归一化约束，必须被拒绝。
  test("拒绝连续连字符名称", () => {
    expect(isValidMcpName("server--one")).toBe(false);
  });

  // 非对象配置统一映射为 INVALID_CONFIG。
  test("配置非对象失败映射", () => {
    expect(validateMcpConfig(undefined)).toBe("INVALID_CONFIG");
    expect(validateMcpConfig("remote")).toBe("INVALID_CONFIG");
    expect(validateMcpConfig(null)).toBe("INVALID_CONFIG");
  });

  // 缺少 type 或 type 非字符串时返回类型错误。
  test("配置类型失败映射", () => {
    expect(validateMcpConfig({ command: ["node"] })).toBe("INVALID_CONFIG_TYPE");
    expect(validateMcpConfig({ type: 1 })).toBe("INVALID_CONFIG_TYPE");
    expect(validateMcpConfig({ type: "stdio" })).toBe("INVALID_CONFIG_TYPE");
  });

  // local 配置必须包含至少一个字符串命令。
  test("local 命令失败映射", () => {
    expect(validateMcpConfig({ type: "local", command: [] })).toBe("INVALID_COMMAND");
    expect(validateMcpConfig({ type: "local", command: ["node", 1] })).toBe("INVALID_COMMAND");
    expect(validateMcpConfig({ type: "local", command: "node" })).toBe("INVALID_COMMAND");
  });

  // local 的 environment 必须是非 null 对象。
  test("local environment 失败映射", () => {
    expect(validateMcpConfig({ type: "local", command: ["node"], environment: null })).toBe("INVALID_ENVIRONMENT");
    expect(validateMcpConfig({ type: "local", command: ["node"], environment: "x" })).toBe("INVALID_ENVIRONMENT");
  });

  // 两类 MCP 的 timeout 都必须为正数。
  test("timeout 失败映射", () => {
    expect(validateMcpConfig({ type: "local", command: ["node"], timeout: 0 })).toBe("INVALID_TIMEOUT");
    expect(validateMcpConfig({ type: "remote", url: "https://x.test", timeout: -1 })).toBe("INVALID_TIMEOUT");
    expect(validateMcpConfig({ type: "streamable-http", url: "https://x.test", timeout: "1" })).toBe("INVALID_TIMEOUT");
  });

  // remote 和 streamable-http 都要求非空 URL。
  test("远程 URL 失败映射", () => {
    expect(validateMcpConfig({ type: "remote", url: "" })).toBe("INVALID_URL");
    expect(validateMcpConfig({ type: "streamable-http" })).toBe("INVALID_URL");
  });

  // headers 必须是对象，合法的 headers 与 timeout 应通过校验。
  test("远程 headers 与完整配置", () => {
    expect(validateMcpConfig({ type: "remote", url: "https://x.test", headers: {}, timeout: 5000 })).toBeNull();
    expect(validateMcpConfig({ type: "streamable-http", url: "https://x.test", headers: null })).toBe(
      "INVALID_HEADERS",
    );
  });

  // 仅 enabled=false 是允许的禁用配置。
  test("禁用配置归一化", () => {
    expect(validateMcpConfig({ enabled: false })).toBeNull();
    expect(validateMcpConfig({ enabled: false, type: "remote" })).toBe("INVALID_URL");
  });

  // local 展示使用命令首项和 timeout。
  test("local 展示信息转换", () => {
    expect(
      toServerInfo("local-one", {
        type: "local",
        config: { type: "local", command: ["npx"], timeout: 1000 },
        enabled: true,
      }),
    ).toEqual({
      name: "local-one",
      type: "local",
      enabled: true,
      summary: "npx",
      timeout: 1000,
    });
  });

  // streamable-http 展示时保持类型标签并使用 URL 摘要。
  test("streamable-http 展示信息转换", () => {
    expect(
      toServerInfo("http-one", {
        type: "streamable-http",
        config: JSON.stringify({ type: "streamable-http", url: "https://x.test" }),
        enabled: true,
      }),
    ).toEqual({
      name: "http-one",
      type: "streamable-http",
      enabled: true,
      summary: "https://x.test",
      timeout: undefined,
    });
  });

  // 没有 type 的禁用行展示为明确的 disabled 摘要。
  test("禁用行展示信息转换", () => {
    expect(toServerInfo("off", { type: "disabled", config: { enabled: false }, enabled: false })).toEqual({
      name: "off",
      type: "disabled",
      enabled: false,
      summary: "已禁用",
    });
  });

  // 组织内部资源会被列出并标记为可写。
  test("列出组织内部资源", async () => {
    installSelect([[row()]]);
    const rows = await listMcpServers(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resourceAccess).toMatchObject({
      ownership: "internal",
      writable: true,
      resourceKey: "org_current/mcp-1",
    });
  });

  // 外部资源只有授权引用且组织与资源 ID 同时匹配时才会进入结果。
  test("共享资源按组织和资源 ID 隔离", async () => {
    const external = row({ id: "mcp-shared", organizationId: "org_source" });
    installSelect([[], [external, row({ id: "mcp-shared", organizationId: "org_other" })]]);
    stubResourcePermissionRepo({
      listAccessibleForPrincipal: async () => [
        { organizationId: "org_source", resourceType: "mcp_server", resourceId: "mcp-shared", hasPublicRead: true },
      ],
    });
    const rows = await listMcpServers(ctx);
    expect(rows.map((item) => item.resourceAccess.resourceKey)).toEqual(["org_source/mcp-shared"]);
  });

  // 通过名称读取不存在的内部和外部资源都返回 null。
  test("按名称读取不存在资源", async () => {
    installSelect([[], []]);
    expect(await getMcpServer(ctx, "missing")).toBeNull();
  });

  // 外部资源未获授权时，按 ID 读取必须返回 null。
  test("按 ID 拒绝未授权外部资源", async () => {
    installSelect([[row({ organizationId: "org_source" })]]);
    expect(await getMcpServerById(ctx, "mcp-1")).toBeNull();
  });

  // resourceKey 格式、所属组织和资源 ID 任一不匹配都不能泄露资源。
  test("resourceKey 三段隔离校验", async () => {
    installSelect([[row({ organizationId: "org_source" })]]);
    stubResourcePermissionRepo({ canReadExternalResource: async () => true });
    expect(await getMcpServerByResourceKey(ctx, "bad-key")).toBeNull();
    expect(await getMcpServerByResourceKey(ctx, "org_other/mcp-1")).toBeNull();
    expect(await getMcpServerByResourceKey(ctx, "/mcp-1")).toBeNull();
  });

  // 创建使用组织和用户上下文，并支持冲突更新返回 ID。
  test("创建 MCP server", async () => {
    let inserted = false;
    stubDb({
      insert: () => ({
        values: (values: unknown) => {
          inserted = values !== undefined;
          return { onConflictDoUpdate: () => ({ returning: async () => [{ id: "mcp-new" }] }) };
        },
      }),
    });
    await expect(
      createMcpServer(ctx, "new-server", "remote", { type: "remote", url: "https://new.test" }),
    ).resolves.toBeUndefined();
    expect(inserted).toBe(true);
  });

  // 创建时 publicReadable=true 会写入 all/read 公开授权。
  test("创建时设置公开读取", async () => {
    let grant = false;
    installMutation({ insert: "mcp-new" });
    stubResourcePermissionRepo({
      createGrant: async () => {
        grant = true;
        return {} as never;
      },
    });
    await createMcpServer(
      ctx,
      "public-server",
      "remote",
      { type: "remote", url: "https://new.test" },
      { publicReadable: true },
    );
    expect(grant).toBe(true);
  });

  // 按名称更新不存在的资源返回 false 且不执行更新。
  test("按名称更新缺失资源", async () => {
    installSelect([[]]);
    stubDb({
      select: () => ({ from: () => ({ where: () => result([]) }) }),
      update: () => {
        throw new Error("unexpected update");
      },
    });
    expect(await updateMcpServer(ctx, "missing", { type: "remote", url: "https://x.test" })).toBe(false);
  });

  // 更新合法 config.type 时同步更新数据库 type。
  test("更新同步合法类型", async () => {
    let updates: unknown;
    installSelect([[row({ type: "local" })]]);
    stubDb({
      select: () => ({ from: () => ({ where: () => result([row({ type: "local" })]) }) }),
      update: () => ({
        set: (value: unknown) => {
          updates = value;
          return { where: () => ({ returning: async () => [{ id: "mcp-1" }] }) };
        },
      }),
    });
    expect(await updateMcpServer(ctx, "shared-server", { type: "remote", url: "https://updated.test" })).toBe(true);
    expect(updates).toMatchObject({ type: "remote" });
  });

  // 按 ID 更新不存在资源返回 false。
  test("按 ID 更新缺失资源", async () => {
    installSelect([[]]);
    expect(await updateMcpServerById(ctx, "missing", { type: "local", command: ["node"] })).toBe(false);
  });

  // 删除和启停都返回底层 mutation 是否命中行。
  test("删除与启停成功路径", async () => {
    const internal = row();
    stubDb({
      select: () => ({ from: () => ({ where: () => result([internal]) }) }),
      delete: () => ({ where: () => ({ returning: async () => [{ id: "mcp-1" }] }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "mcp-1" }] }) }) }),
    });
    expect(await deleteMcpServer(ctx, internal.name)).toBe(true);
    expect(await deleteMcpServerById(ctx, internal.id)).toBe(true);
    expect(await setMcpServerEnabled(ctx, internal.name, false)).toBe(true);
  });

  // assert helper 对缺失资源返回 null，并对内部资源原样返回装饰行。
  test("内部可写断言 helper", async () => {
    installSelect([[row()], [row()]]);
    const byName = await assertMcpServerInternalWritable(ctx, "shared-server");
    const byId = await assertMcpServerInternalWritableById(ctx, "mcp-1");
    expect(byName?.id).toBe("mcp-1");
    expect(byId?.id).toBe("mcp-1");
  });

  // tool count 使用 SQL 聚合结果，并在空结果时归一化为 0。
  test("tool 数量读取与零值归一化", async () => {
    stubDb({ select: () => ({ from: () => ({ where: async () => [{ count: "3" }] }) }) });
    expect(await countToolsByServer("org_current", "shared-server")).toBe(3);
    stubDb({ select: () => ({ from: () => ({ where: async () => [] }) }) });
    expect(await countToolsByServer("org_current", "empty-server")).toBe(0);
  });

  // listToolsByServer 只读取指定组织和 serverName 的缓存工具。
  test("读取指定 server 的工具缓存", async () => {
    const tools = [{ id: "tool-1", organizationId: "org_current", serverName: "shared-server", toolName: "search" }];
    stubDb({ select: () => ({ from: () => ({ where: async () => tools }) }) });
    expect(await listToolsByServer("org_current", "shared-server")).toEqual(tools);
  });

  // 删除工具缓存只执行 delete，不触碰其他 server 的数据。
  test("删除指定 server 的工具缓存", async () => {
    let deleted = false;
    stubDb({
      delete: () => ({
        where: async () => {
          deleted = true;
        },
      }),
    });
    await deleteToolsByServer("org_current", "shared-server");
    expect(deleted).toBe(true);
  });

  // 替换工具先删除旧缓存，非空输入再插入带默认 null 的新行。
  test("原子替换工具缓存", async () => {
    const operations: string[] = [];
    stubDb({
      transaction: async (
        callback: (tx: {
          delete: () => { where: () => Promise<void> };
          insert: () => { values: (rows: unknown[]) => Promise<void> };
        }) => Promise<void>,
      ) =>
        callback({
          delete: () => ({
            where: async () => {
              operations.push("delete");
            },
          }),
          insert: () => ({
            values: async (rows: unknown[]) => {
              operations.push(`insert:${rows.length}`);
            },
          }),
        }),
    });
    await replaceToolsForServer("org_current", "shared-server", [
      { name: "search" },
      { name: "fetch", description: "fetches" },
    ]);
    expect(operations).toEqual(["delete", "insert:2"]);
  });

  // 替换为空工具列表时只删除旧缓存，不发起空插入。
  test("空工具列表替换不插入", async () => {
    let inserts = 0;
    stubDb({
      transaction: async (
        callback: (tx: {
          delete: () => { where: () => Promise<void> };
          insert: () => { values: (rows: unknown[]) => Promise<void> };
        }) => Promise<void>,
      ) =>
        callback({
          delete: () => ({ where: async () => {} }),
          insert: () => ({
            values: async () => {
              inserts += 1;
            },
          }),
        }),
    });
    await replaceToolsForServer("org_current", "empty-server", []);
    expect(inserts).toBe(0);
  });
});
