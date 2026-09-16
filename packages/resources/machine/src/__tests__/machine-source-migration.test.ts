import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "../../../../..");

// RMD-02 迁移后的公开 server 入口必须同时提供路由、schema 与服务能力。
test("Machine server 入口公开已迁移的文件能力", async () => {
  const server = await import("@fenix/resource-machine/server");

  expect(server.webFsRoutes).toBeDefined();
  expect(server.webFileEventsRoutes).toBeDefined();
  expect(server.webRegistryRoutes).toBeDefined();
  expect(server.apiWorkspaceRoutes).toBeDefined();
  expect(server.FileEventsSubscribeSchema).toBeDefined();
  expect(server.LocalNodeAwareService).toBeDefined();
  expect(server.eventService).toBeDefined();
});

// RMD-02 完成后根目录不能保留 Machine/File 的同名实现或兼容垫片。
test("Machine/File 根目录旧路径已删除", () => {
  for (const path of [
    "src/routes/api/workspaces.ts",
    "src/routes/web/fs.ts",
    "src/routes/web/registry.ts",
    "src/routes/web/file-events.ts",
    "src/schemas/file.schema.ts",
    "src/schemas/file-events.schema.ts",
    "src/schemas/registry.schema.ts",
    "src/services/event-service.ts",
    "src/services/local-node-service.ts",
    "src/__tests__/fs-symlink-escape.test.ts",
    "src/__tests__/fs-upload-escape.test.ts",
    "src/__tests__/local-node-service.test.ts",
    "src/__tests__/machine-resource-surface.test.ts",
    "src/__tests__/machine-sandbox-projection.test.ts",
    "src/__tests__/registry-filews-cleanup.test.ts",
    "src/__tests__/registry-machine-stages.test.ts",
    "src/__tests__/registry-routes-isolation.test.ts",
    "src/__tests__/registry-routes.test.ts",
    "src/__tests__/registry-schema.test.ts",
    "src/__tests__/registry-service.test.ts",
    "src/__tests__/round19-registry-service-boundaries.test.ts",
    "src/__tests__/round36-registry-service-coverage.test.ts",
    "src/__tests__/round39-registry-service.test.ts",
    "src/__tests__/round68-registry-heartbeat.test.ts",
    "web/src/__tests__/file-icon-and-card-registry-pure.test.ts",
    "web/src/__tests__/file-icon-helper-round39.test.ts",
    "web/src/__tests__/file-picker-dialog.test.tsx",
    "web/src/__tests__/file-picker-round49-pure.test.ts",
    "web/src/__tests__/file-tree-dialog.test.ts",
    "web/src/__tests__/file-tree-model.test.ts",
  ]) {
    expect(existsSync(resolve(repositoryRoot, path))).toBeFalse();
  }
});

// 物理迁移必须落到清单规定的 Machine 目录；仅删除旧文件会破坏测试归属与可追溯性。
test("Machine/File 文件均落在规定的新 owner 路径", () => {
  for (const path of [
    "packages/resources/machine/src/routes/api/workspaces.ts",
    "packages/resources/machine/src/routes/web/fs.ts",
    "packages/resources/machine/src/routes/web/registry.ts",
    "packages/resources/machine/src/routes/web/file-events.ts",
    "packages/resources/machine/src/schemas/file.schema.ts",
    "packages/resources/machine/src/schemas/file-events.schema.ts",
    "packages/resources/machine/src/schemas/registry.schema.ts",
    "packages/resources/machine/src/services/event-service.ts",
    "packages/resources/machine/src/services/local-node-service.ts",
    "packages/resources/machine/src/__tests__/fs-symlink-escape.test.ts",
    "packages/resources/machine/src/__tests__/fs-upload-escape.test.ts",
    "packages/resources/machine/src/__tests__/local-node-service.test.ts",
    "packages/resources/machine/src/__tests__/machine-resource-surface.test.ts",
    "packages/resources/machine/src/__tests__/machine-sandbox-projection.test.ts",
    "packages/resources/machine/src/__tests__/registry-filews-cleanup.test.ts",
    "packages/resources/machine/src/__tests__/registry-machine-stages.test.ts",
    "packages/resources/machine/src/__tests__/registry-routes-isolation.test.ts",
    "packages/resources/machine/src/__tests__/registry-routes.test.ts",
    "packages/resources/machine/src/__tests__/registry-schema.test.ts",
    "packages/resources/machine/src/__tests__/registry-service.test.ts",
    "packages/resources/machine/src/__tests__/round19-registry-service-boundaries.test.ts",
    "packages/resources/machine/src/__tests__/round36-registry-service-coverage.test.ts",
    "packages/resources/machine/src/__tests__/round39-registry-service.test.ts",
    "packages/resources/machine/src/__tests__/round68-registry-heartbeat.test.ts",
    "packages/resources/machine/web/src/__tests__/file-icon-and-card-registry-pure.test.ts",
    "packages/resources/machine/web/src/__tests__/file-icon-helper-round39.test.ts",
    "packages/resources/machine/web/src/__tests__/file-picker-dialog.test.tsx",
    "packages/resources/machine/web/src/__tests__/file-picker-round49-pure.test.ts",
    "packages/resources/machine/web/src/__tests__/file-tree-dialog.test.ts",
    "packages/resources/machine/web/src/__tests__/file-tree-model.test.ts",
  ]) {
    expect(existsSync(resolve(repositoryRoot, path))).toBeTrue();
  }
});
