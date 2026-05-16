# Agent Task Runner 进程管理提取 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `agent-task-runner.ts` 中的 workspace 准备逻辑（文件系统操作）提取为独立函数，将进程 spawn 改为可注入，提高可测试性。

**Architecture:** 当前 `runAgentTask()` 混合了 4 种职责：workspace 路径计算、目录+配置文件创建、进程 spawn 和超时管理、结果摘要。提取 workspace 准备为纯函数，进程 spawn 通过参数注入。

**Tech Stack:** TypeScript, Node.js child_process

---

### Task 1: 提取 workspace 准备为纯函数

**Files:**
- Modify: `src/services/agent-task-runner.ts`

- [ ] **Step 1: 提取 `prepareRunWorkspace` 函数**

将 lines 55-62 的 workspace 创建逻辑提取为独立导出函数：

```typescript
export async function prepareRunWorkspace(
  baseWorkspacePath: string,
  taskId: string,
  logId: string,
  agentName: string | null,
): Promise<{ runDir: string; workspaceName: string }> {
  const runDir = buildRunWorkspacePath(baseWorkspacePath, taskId, logId);
  const opencodeConfigDir = join(runDir, ".opencode");
  const workspaceName = basename(runDir);
  const config = agentName ? { default_agent: agentName } : {};

  await mkdir(runDir, { recursive: true });
  await mkdir(opencodeConfigDir, { recursive: true });
  await writeFile(join(opencodeConfigDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

  return { runDir, workspaceName };
}
```

- [ ] **Step 2: 在 `runAgentTask` 中调用**

替换内联的 mkdir/writeFile 调用为：
```typescript
const { runDir, workspaceName } = await prepareRunWorkspace(env.workspacePath, input.taskId, input.logId, defaultAgent);
```

- [ ] **Step 3: 将 `buildRunWorkspacePath` 也改为 export**

当前 `buildRunWorkspacePath` 是 private 函数，导出以便测试。

- [ ] **Step 4: 运行 typecheck**

Run: `bunx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/services/agent-task-runner.ts
git commit -m "refactor: 提取 prepareRunWorkspace 纯函数，隔离文件系统操作"
```

### Task 2: 将进程 spawn 改为可注入

**Files:**
- Modify: `src/services/agent-task-runner.ts`

- [ ] **Step 1: 定义 SpawnFunction 类型**

```typescript
export type SpawnFunction = typeof import("node:child_process").spawn;
```

- [ ] **Step 2: 在 `RunAgentTaskInput` 中添加可选 `spawnFn` 参数**

```typescript
export interface RunAgentTaskInput {
  userId: string;
  environmentId: string;
  taskId: string;
  taskText: string;
  timeoutMinutes: number;
  logId: string;
  spawnFn?: SpawnFunction;
}
```

- [ ] **Step 3: 在 `runAgentTask` 中使用注入的 spawn**

```typescript
const doSpawn = input.spawnFn ?? spawn;
const proc = doSpawn(opencodePath, ["run", input.taskText], { ... });
```

- [ ] **Step 4: 运行 typecheck**

Run: `bunx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/services/agent-task-runner.ts
git commit -m "refactor: agent-task-runner 支持注入 spawn 函数，提高可测试性"
```

### Task 3: 补充单元测试

**Files:**
- Create: `src/__tests__/agent-task-runner.test.ts`

- [ ] **Step 1: 测试 `buildRunWorkspacePath` 纯函数**

验证路径格式、时间戳格式、不同 taskId 的路径隔离。

- [ ] **Step 2: 测试 `prepareRunWorkspace`**

使用临时目录验证：
- 目录创建正确
- config.json 内容正确
- agentName 为 null 时 config 为空对象

- [ ] **Step 3: 测试 `runAgentTask` 用 mock spawn**

注入 `spawnFn` 返回 mock child process，验证：
- 超时触发 SIGTERM
- 正常退出返回 success
- 非零退出返回 failed
- 错误事件正确传播

- [ ] **Step 4: 运行测试**

Run: `bun test src/__tests__/agent-task-runner.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/agent-task-runner.test.ts
git commit -m "test: 补充 agent-task-runner 单元测试"
```
