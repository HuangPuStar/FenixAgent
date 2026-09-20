import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../../../..");
const serverEntry = resolve(import.meta.dir, "../server.ts");

const oldPaths = [
  "src/routes/api/sandbox.ts",
  "src/routes/api/sandbox-cluster.ts",
  "src/routes/api/sandbox-server.ts",
  "src/__tests__/api-sandbox-schema.test.ts",
  "src/__tests__/api-sandbox-server.test.ts",
  "src/__tests__/sandbox-api-error-mapping.test.ts",
  "src/__tests__/sandbox-cluster-admin-service.test.ts",
  "src/__tests__/sandbox-config.test.ts",
  "src/__tests__/sandbox-default-pool.test.ts",
  "src/__tests__/sandbox-execution-handler.test.ts",
  "src/__tests__/sandbox-manager.test.ts",
  "src/__tests__/sandbox-pool-config-api.test.ts",
  "src/__tests__/sandbox-provider-registry.test.ts",
  "src/__tests__/sandbox-schema.test.ts",
  "src/__tests__/sandbox-server-admin-service.test.ts",
  "web/src/api/sandbox-pools.ts",
  "web/src/api/system-sandbox.ts",
  "web/src/pages/admin/AdminSandboxPage.tsx",
  "web/src/pages/admin/utils.ts",
  "web/src/pages/admin/components/MasterKeyGate.tsx",
  "web/src/pages/admin/components/RemoteSandboxPanel.tsx",
  "web/src/pages/admin/components/SearchableUsageFilter.tsx",
];

const targetPaths = oldPaths.map((path) => {
  if (path.startsWith("src/routes/api/"))
    return `packages/resources/sandbox/src/routes/api/${path.slice("src/routes/api/".length)}`;
  if (path.startsWith("src/__tests__/"))
    return `packages/resources/sandbox/src/__tests__/${path.slice("src/__tests__/".length)}`;
  return `packages/resources/sandbox/web/src/${path.slice("web/src/".length)}`;
});

// RMD-03 完成后根目录不得保留 Sandbox 的第二份实现。
test("Sandbox 根目录旧路径已全部删除", () => {
  expect(oldPaths.filter((path) => existsSync(resolve(repositoryRoot, path)))).toEqual([]);
});

// 物理迁移必须完整落到 resource-sandbox 约定目录。
test("Sandbox 文件均落在规定的新 owner 路径", () => {
  expect(targetPaths.filter((path) => !existsSync(resolve(repositoryRoot, path)))).toEqual([]);
});

// 宿主只能经稳定 server 入口装配 Sandbox 路由；守卫由宿主注入，因此入口导出的是工厂。
test("Sandbox server 入口导出已迁移的路由工厂", () => {
  const source = readFileSync(serverEntry, "utf8");

  expect(source).toContain('export { createApiSandboxRoutes, mapSandboxApiError } from "./routes/api/sandbox"');
  expect(source).toContain(
    'export { createApiSandboxClusterRoutes, mapSandboxClusterAdminError } from "./routes/api/sandbox-cluster"',
  );
  expect(source).toContain('export { createApiSandboxServerRoutes } from "./routes/api/sandbox-server"');
});
