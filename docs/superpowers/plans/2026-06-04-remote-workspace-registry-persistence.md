# 远程文件系统 workspace 持久化修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 acp-link 进程重启后 workspaceCache 丢失导致远程文件操作全部失败的问题。

**Architecture:** 将纯内存的 `workspaceCache` 改为文件系统持久化方案。acp-link 启动时从 `.workspace-registry.json` 加载已有映射，`registerWorkspace` 时同步写入磁盘，确保重启后映射不丢失。同时增加 `unregisterWorkspace` 在 `stop` 时清理。

**Tech Stack:** Node.js fs/promises, JSON 序列化, Bun test

---

## 根因回顾

```
正常流程: prepare → registerWorkspace(envId, workspace) → file_op 正常
重启后:   acp-link 重连 → workspaceCache 为空 → file_op 返回 "Workspace not found"
```

`workspaceCache`（`file-operations.ts:36`）是纯内存 Map，只有 `InstanceManager.prepare()` 调用 `registerWorkspace()` 才会填充。acp-link 进程重启后缓存丢失，但 RCS 端不会为已 running 的实例重新发 `prepare`。

## 文件结构

| 文件 | 职责 |
|------|------|
| `packages/acp-link/src/client/workspace-registry.ts` | 新建：workspace 映射持久化模块 |
| `packages/acp-link/src/client/file-operations.ts` | 修改：`workspaceCache` 替换为持久化 registry |
| `packages/acp-link/src/client/instance-manager.ts` | 修改：`prepare` 使用新 registry，`stop` 调用清理 |
| `packages/acp-link/src/server.ts` | 修改：`createAcpClient` 启动时加载 registry |

---

### Task 1: 创建 workspace-registry 持久化模块

**Files:**
- Create: `packages/acp-link/src/client/workspace-registry.ts`

- [ ] **Step 1: 实现 workspace-registry.ts**

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const REGISTRY_FILENAME = ".workspace-registry.json";

/** environmentId → absolute workspace path */
const cache = new Map<string, string>();

let registryPath: string | null = null;

/**
 * 初始化 registry：设置文件路径并从磁盘加载已有映射。
 * 在 createAcpClient 启动时调用一次。
 */
export async function initRegistry(workspaceRoot: string): Promise<void> {
  registryPath = join(workspaceRoot, REGISTRY_FILENAME);
  try {
    const raw = await readFile(registryPath, "utf-8");
    const data = JSON.parse(raw) as Record<string, string>;
    for (const [envId, ws] of Object.entries(data)) {
      cache.set(envId, ws);
    }
    console.log(`[workspace-registry] loaded ${cache.size} mapping(s) from ${registryPath}`);
  } catch {
    // 文件不存在或解析失败，从空开始
    console.log(`[workspace-registry] no existing registry, starting fresh`);
  }
}

/** 注册 environmentId → workspace 映射，同时持久化到磁盘 */
export async function registerWorkspace(environmentId: string, workspace: string): Promise<void> {
  cache.set(environmentId, workspace);
  await flushToDisk();
  console.log(`[workspace-registry] registered: ${environmentId} → ${workspace}`);
}

/** 注销映射（instance stop 时调用），同时持久化 */
export async function unregisterWorkspace(environmentId: string): Promise<void> {
  cache.delete(environmentId);
  await flushToDisk();
  console.log(`[workspace-registry] unregistered: ${environmentId}`);
}

/** 查询映射 */
export function getWorkspace(environmentId: string): string | null {
  return cache.get(environmentId) ?? null;
}

/** 同步查询（用于 handleFileOp） */
export function getWorkspaceSync(environmentId: string): string | null {
  return cache.get(environmentId) ?? null;
}

/** 将当前缓存写入磁盘 */
async function flushToDisk(): Promise<void> {
  if (!registryPath) return;
  const data: Record<string, string> = {};
  for (const [k, v] of cache) {
    data[k] = v;
  }
  await writeFile(registryPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/acp-link/src/client/workspace-registry.ts
git commit -m "feat(acp-link): add persistent workspace-registry module"
```

---

### Task 2: file-operations.ts 切换到持久化 registry

**Files:**
- Modify: `packages/acp-link/src/client/file-operations.ts:32-46`

- [ ] **Step 1: 替换 workspaceCache 为 workspace-registry**

将 `file-operations.ts` 的 `workspaceCache` 相关代码（L32-46）替换为从 `workspace-registry` 导入：

```ts
// 删除旧的 workspaceCache Map 和 registerWorkspace/getWorkspace 函数
// 替换为：

import { getWorkspaceSync } from "./workspace-registry.js";

// 重新导出 registerWorkspace（供 instance-manager.ts 调用）
export { registerWorkspace, unregisterWorkspace } from "./workspace-registry.js";
```

同时更新 `handleFileOp`（约 L417）中的调用：

```ts
// 原来：const workspace = getWorkspace(environmentId);
// 改为：
const workspace = getWorkspaceSync(environmentId);
```

删除旧的 `workspaceCache`、`registerWorkspace`、`getWorkspace` 定义（L35-46）。

- [ ] **Step 2: Commit**

```bash
git add packages/acp-link/src/client/file-operations.ts
git commit -m "refactor(acp-link): switch file-operations to persistent workspace registry"
```

---

### Task 3: InstanceManager 在 stop 时清理映射

**Files:**
- Modify: `packages/acp-link/src/client/instance-manager.ts`

- [ ] **Step 1: 导入并使用 registerWorkspace / unregisterWorkspace**

在 `instance-manager.ts` 顶部导入：

```ts
import { registerWorkspace, unregisterWorkspace } from "./workspace-registry.js";
```

删除旧的导入：
```ts
// 删除：import { registerWorkspace } from "./file-operations.js";
```

在 `prepare()` 方法中，`registerWorkspace` 调用已经是异步的，需要 `await`：

```ts
// 原来：registerWorkspace(launchSpec.environmentId, workspace);
// 改为：
await registerWorkspace(launchSpec.environmentId, workspace);
```

在 `stop()` 方法中添加清理（`this.instances.delete(instanceId)` 之前）：

```ts
// 获取 environmentId 用于清理 workspace 映射
const launchSpec = state.launchSpec;
if (launchSpec?.environmentId) {
  await unregisterWorkspace(launchSpec.environmentId).catch(() => {});
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/acp-link/src/client/instance-manager.ts
git commit -m "feat(acp-link): cleanup workspace mapping on instance stop"
```

---

### Task 4: createAcpClient 启动时加载 registry

**Files:**
- Modify: `packages/acp-link/src/server.ts`

- [ ] **Step 1: 在 createAcpClient 中初始化 registry**

在 `server.ts` 顶部添加导入：

```ts
import { initRegistry } from "./client/workspace-registry.js";
```

在 `createAcpClient` 函数体内、`setupSessionCallbacks()` 之前，调用初始化：

```ts
export function createAcpClient(config: ServerConfig): { close: () => void } {
  if (!config.rcsUrl) {
    throw new Error("rcsUrl is required for client mode");
  }

  // 从磁盘加载 workspace 映射（acp-link 重启后恢复）
  initRegistry(config.cwd || process.cwd()).catch((err) => {
    console.error("[acp-client] Failed to load workspace registry:", err);
  });

  const sessionMgr = ...
```

- [ ] **Step 2: Commit**

```bash
git add packages/acp-link/src/server.ts
git commit -m "feat(acp-link): load workspace registry on client startup"
```

---

### Task 5: 验证 precheck 通过

- [ ] **Step 1: 运行 precheck**

```bash
bun run precheck
```

Expected: tsc 编译通过，biome 无新 error（已有的 warning/info 不算）

- [ ] **Step 2: 运行现有测试**

```bash
bun test packages/acp-link/ packages/plugin-ccb/ packages/plugin-opencode/ 2>&1 | tail -20
```

Expected: 所有测试通过，无 regression

- [ ] **Step 3: Commit（如有自动修复）**

```bash
git add -A && git commit -m "chore: precheck fixes" || echo "No changes needed"
```
