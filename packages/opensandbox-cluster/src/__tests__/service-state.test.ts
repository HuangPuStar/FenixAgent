import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import { BindingRepository } from "../repositories/binding-repository";
import { createSecretBox } from "../security/secret-box";
import { PoolService } from "../services/pool-service";
import { ServerService } from "../services/server-service";

const API_KEY_PLACEHOLDER = "placeholder-api-key";

let sqlite: Database;
let poolService: PoolService;
let serverService: ServerService;
let bindings: BindingRepository;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    CREATE TABLE sandbox_pool (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE opensandbox_server (id TEXT PRIMARY KEY, pool_id TEXT NOT NULL REFERENCES sandbox_pool(id), name TEXT NOT NULL, base_url TEXT NOT NULL, workspace_root TEXT NOT NULL, api_key_ciphertext TEXT NOT NULL, max_sandboxes INTEGER NOT NULL, status TEXT NOT NULL, health_status TEXT NOT NULL, last_health_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sandbox_binding (sandbox_id TEXT PRIMARY KEY, pool_id TEXT NOT NULL REFERENCES sandbox_pool(id), server_id TEXT NOT NULL REFERENCES opensandbox_server(id), created_at INTEGER NOT NULL);
  `);
  poolService = new PoolService(db);
  serverService = new ServerService(db, createSecretBox(new Uint8Array(32)));
  bindings = new BindingRepository(db);
});

function createPool(id = "pool-1") {
  return poolService.create({ id, name: `Pool ${id}` });
}

function createServer(
  id = "server-1",
  poolId = "pool-1",
  overrides?: Partial<{ status: string; max_sandboxes: number; workspace_root: string }>,
) {
  return serverService.create({
    id,
    pool_id: poolId,
    name: `Server ${id}`,
    base_url: "https://sandbox.example.test",
    workspace_root: "/workspaces/sandboxes",
    api_key: API_KEY_PLACEHOLDER,
    max_sandboxes: 2,
    ...overrides,
  });
}

describe("OpenSandbox 管理服务内存状态", () => {
  // 创建池默认启用，供后续分配流程立即使用。
  test("创建池默认状态为 active", () => {
    expect(createPool()).toMatchObject({ id: "pool-1", name: "Pool pool-1", status: "active" });
  });

  // 显式停用状态不得被默认值覆盖。
  test("创建池保留显式状态", () => {
    expect(poolService.create({ id: "pool-paused", name: "Paused", status: "paused" }).status).toBe("paused");
  });

  // 更新仅影响指定字段并保留池身份。
  test("更新池名称", () => {
    createPool();

    expect(poolService.update("pool-1", { name: "Renamed" })).toMatchObject({ id: "pool-1", name: "Renamed" });
  });

  // 不存在池查询应显式返回 undefined。
  test("查询不存在的池返回 undefined", () => {
    expect(poolService.findById("missing")).toBeUndefined();
  });

  // 空池可安全删除，避免遗留不可达配置。
  test("删除空池", () => {
    createPool();

    expect(poolService.delete("pool-1")?.id).toBe("pool-1");
    expect(poolService.findById("pool-1")).toBeUndefined();
  });

  // 有服务器的池不能删除，以保持绑定拓扑完整。
  test("拒绝删除仍有服务器的池", () => {
    createPool();
    createServer();

    expect(() => poolService.delete("pool-1")).toThrow("pool has servers or active sandbox bindings");
  });

  // 有绑定的池不能删除，以免孤儿 sandbox 指向不存在的池。
  test("拒绝删除仍有绑定的池", () => {
    createPool();
    createServer();
    bindings.insert({ sandboxId: "sandbox-1", poolId: "pool-1", serverId: "server-1", createdAt: Date.now() });

    expect(() => poolService.delete("pool-1")).toThrow("pool has servers or active sandbox bindings");
  });

  // 容量统计应区分总容量、当前绑定和可用健康容量。
  test("池容量仅计入健康且启用的服务器", () => {
    createPool();
    createServer("healthy");
    createServer("unhealthy");
    serverService.update("healthy", { max_sandboxes: 3 });
    serverService.update("unhealthy", { max_sandboxes: 4 });
    sqlite.exec("UPDATE opensandbox_server SET health_status = 'healthy' WHERE id = 'healthy'");
    bindings.insert({ sandboxId: "sandbox-1", poolId: "pool-1", serverId: "healthy", createdAt: Date.now() });
    bindings.insert({ sandboxId: "sandbox-2", poolId: "pool-1", serverId: "unhealthy", createdAt: Date.now() });

    expect(poolService.findById("pool-1")).toMatchObject({
      currentSandboxes: 2,
      capacitySandboxes: 7,
      availableSandboxes: 2,
    });
  });

  // 服务器必须归属已存在的池，防止跨租户悬挂记录。
  test("拒绝向不存在的池创建服务器", () => {
    expect(() => createServer("server-orphan", "missing")).toThrow("pool not found");
  });

  // 对外服务器视图不得泄露加密后的凭据字段。
  test("创建服务器时隐藏凭据密文", () => {
    createPool();

    expect(createServer()).not.toHaveProperty("apiKeyCiphertext");
  });

  // 规范化路径应清理尾随分隔符和 Windows 分隔符。
  test("创建服务器时规范化工作区根路径", () => {
    createPool();

    expect(createServer("server-path", "pool-1", { workspace_root: "\\workspaces\\sandbox\\" }).workspaceRoot).toBe(
      "/workspaces/sandbox",
    );
  });

  // 相对路径可导致宿主目录逃逸，必须在边界拒绝。
  test("拒绝相对工作区根路径", () => {
    createPool();

    expect(() => createServer("server-relative", "pool-1", { workspace_root: "relative/path" })).toThrow(
      "workspace_root must be an absolute path",
    );
  });

  // 根目录过宽，会破坏 sandbox 目录隔离。
  test("拒绝文件系统根目录作为工作区", () => {
    createPool();

    expect(() => createServer("server-root", "pool-1", { workspace_root: "/" })).toThrow(
      "workspace_root must be an absolute path",
    );
  });

  // 路径遍历必须在配置写入前被拒绝。
  test("拒绝包含路径遍历的工作区", () => {
    createPool();

    expect(() => createServer("server-traversal", "pool-1", { workspace_root: "/workspaces/../etc" })).toThrow(
      "workspace_root must not be the filesystem root or contain path traversal",
    );
  });

  // 有活动绑定的服务器不能迁移到其他池。
  test("拒绝迁移有绑定的服务器", () => {
    createPool();
    createPool("pool-2");
    createServer();
    bindings.insert({ sandboxId: "sandbox-1", poolId: "pool-1", serverId: "server-1", createdAt: Date.now() });

    expect(() => serverService.update("server-1", { pool_id: "pool-2" })).toThrow(
      "server with bindings cannot move pools",
    );
  });

  // 缩容不能低于已绑定数量，避免现有 sandbox 突然无容量归属。
  test("拒绝将服务器容量缩小到当前绑定数以下", () => {
    createPool();
    createServer();
    bindings.insert({ sandboxId: "sandbox-1", poolId: "pool-1", serverId: "server-1", createdAt: Date.now() });

    expect(() => serverService.update("server-1", { max_sandboxes: 0 })).toThrow(
      "max_sandboxes cannot be below current bindings",
    );
  });

  // 列表按池过滤，避免控制面混入其他池的服务器。
  test("按池筛选服务器列表", () => {
    createPool();
    createPool("pool-2");
    createServer("server-1", "pool-1");
    createServer("server-2", "pool-2");

    expect(serverService.list("pool-1").map((server) => server.id)).toEqual(["server-1"]);
  });

  // 对外列表仍需报告绑定计数，但不能带出凭据密文。
  test("服务器列表报告当前绑定数且隐藏凭据", () => {
    createPool();
    createServer();
    bindings.insert({ sandboxId: "sandbox-1", poolId: "pool-1", serverId: "server-1", createdAt: Date.now() });

    expect(serverService.list()).toEqual([expect.objectContaining({ id: "server-1", currentSandboxes: 1 })]);
    expect(serverService.list()[0]).not.toHaveProperty("apiKeyCiphertext");
  });

  // 控制面内部凭据读取应能还原原始密钥，不依赖外部密钥服务。
  test("获取服务器凭据时解密 API key", () => {
    createPool();
    createServer();

    expect(serverService.getCredentials("server-1")?.apiKey).toBe(API_KEY_PLACEHOLDER);
  });

  // 缺失服务器的突变和凭据查询都应无副作用地返回 undefined。
  test("缺失服务器的更新和凭据查询返回 undefined", () => {
    expect(serverService.update("missing", { name: "ignored" })).toBeUndefined();
    expect(serverService.getCredentials("missing")).toBeUndefined();
    expect(serverService.delete("missing")).toBeUndefined();
  });

  // 有绑定的服务器不可删除，确保已分配 sandbox 的路由仍有效。
  test("拒绝删除有绑定的服务器", () => {
    createPool();
    createServer();
    bindings.insert({ sandboxId: "sandbox-1", poolId: "pool-1", serverId: "server-1", createdAt: Date.now() });

    expect(() => serverService.delete("server-1")).toThrow("server has active sandbox bindings");
  });
});
