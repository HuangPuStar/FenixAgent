# 去除智能体创建时的 Workspace 路径，改用 orgId+userId 自动计算

## 背景

当前创建智能体（环境）时，用户需要手动指定 `workspacePath`，该路径存入 DB `environment` 表，在 spawn 实例时读取并传递给 `AgentLaunchSpec.workspace`，最终由 `plugin-opencode` 使用该路径作为 acp-link 子进程的 `cwd`。

这种方式要求用户提前知道并管理文件路径，增加了使用复杂度，也不适合多租户场景。

## 目标

- 去除前端创建/编辑环境时的 `workspacePath` 输入框
- `plugin-opencode` 根据传入的 `organizationId` + `userId` 自动计算用户隔离的工作区路径
- 同一用户在同一 org 下所有 agent 共享一个 workspace，多次启动也复用

## 设计决策

### 1. 路径算法

```
{WORKSPACE_ROOT ?? cwd/workspaces}/{organizationId}/{userId}
```

- 隔离维度：org + user 两级，所有 agent 共享
- 多实例：共享同一个 workspace
- `cwd` 指服务器启动目录（`process.cwd()`）

### 2. AgentLaunchSpec 变更

`packages/plugin-sdk/src/agent-launch-spec.ts`：

```typescript
// 旧
export interface AgentLaunchSpec {
  workspace: string;
  // ...
}

// 新
export interface AgentLaunchSpec {
  organizationId: string;
  userId: string;
  // ...
}
```

### 3. 环境变量

在 `src/env.ts` 注册 `WORKSPACE_ROOT: z.string().optional()`，默认 `process.cwd() + "/workspaces"`。

### 4. 数据库

DB 的 `environment` 表 `workspacePath` 列保留但不再读取，不兼容旧值。

### 5. 前端

- 移除 `EnvironmentsPage` 的 workspace 输入框及相关 form state
- 移除环境列表中的 `workspace_path` 列显示
- 删除对应的 i18n key

### 6. 后端

- `spawnInstanceFromEnvironment()` 不再从 `env.workspacePath` 读取，改为从 `AuthContext` 获取 `organizationId` + `userId` 传给 `AgentLaunchSpec`
- 环境创建/更新 API 忽略 `workspacePath` 字段，不报错

### 7. plugin-opencode

在 `opencode-runtime.ts` 内新增 `resolveWorkspace(organizationId, userId)` 函数，在 `prepareEnvironment()` 中调用，计算实际 workspace 路径。后续 `startInstance` 从 `state.workspace` 取值的逻辑不变。

### 8. 不涉及的改动

- `acp-link-process-manager.ts`：不需要改动，它从 `state.workspace` 取 `cwd`
- relay 层：`organizationId`/`userId` 通过 `AgentLaunchSpec` 传递，不经过 relay WebSocket
