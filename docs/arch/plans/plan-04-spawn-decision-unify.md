# Plan 04：Instance spawn 决策权统一到 Environment

## Context

当前 Instance spawn 由三种触发者各自直接调用 `spawnInstanceFromEnvironment()`，缺乏统一决策。目标是由 Environment 作为资源管理层，统一管理 Instance 的 spawn 决策。

## 现状分析

### 当前触发者

| 触发者 | 入口 | 决策逻辑 |
|--------|------|----------|
| 用户手动 | `POST /instances/from-environment` → `spawnInstanceFromEnvironment()` | 无策略检查 |
| autoStart | `src/index.ts` 遍历 autoStart 环境 → `spawnInstanceFromEnvironment()` | 仅检查 autoStart 标志 |
| IMChannel | `hermes-client.ts` → `sendToInstanceLocalWs()` 或 `sendToAgentWs()` | 不触发 spawn，只找现有实例 |

### 目标策略

Environment 统一决策：
- 是否已有 running Instance（复用）
- autoStart 配置
- 并发实例上限（maxSessions）
- 端口资源是否充足

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/services/instance.ts` | 新增 `ensureRunning(environmentId)` 接口，封装 spawn 决策 |
| `src/services/hermes-client.ts` | 消息路由改为调用 `ensureRunning()` |
| `src/routes/web/environments.ts` | `POST /environments/:id/enter` 成为统一入口 |
| `src/index.ts` | autoStart 改用 `ensureRunning()` |
| `src/store.ts` | 新增 `storeCountRunningInstances(environmentId)` 查询 |

## 具体实施步骤

### Step 1：定义 `ensureRunning()` 决策接口

```typescript
// src/services/instance.ts
interface EnsureRunningResult {
  instanceId: string;
  status: "reused" | "spawned";
}

async function ensureRunning(userId: string, environmentId: string): Promise<EnsureRunningResult> {
  // 1. 检查是否已有 running instance
  const existing = findRunningInstanceByEnvironment(environmentId);
  if (existing) return { instanceId: existing.id, status: "reused" };

  // 2. 检查 maxSessions 限制
  const env = await getEnvironment(environmentId);
  const runningCount = storeCountRunningInstances(environmentId);
  if (runningCount >= env.maxSessions) throw new Error("max_sessions_reached");

  // 3. 检查端口资源
  // 4. 执行 spawn
  return spawnInstanceFromEnvironment(userId, environmentId);
}
```

### Step 2：统一触发入口

```typescript
// src/routes/web/environments.ts
// POST /environments/:id/enter → 调用 ensureRunning()

// src/index.ts (autoStart)
// await ensureRunning(userId, env.id);

// src/services/hermes-client.ts
// routeToAgent() → await ensureRunning(userId, agentId);
```

### Step 3：前端适配

- "启动并连接"按钮统一调用 `POST /environments/:id/enter`
- 返回结果中区分 reused/spawned 状态，前端可做不同展示

## 验证方式

```bash
# 单元测试
bun test src/__tests__/

# 集成验证
bun run dev
# 1. 手动启动 Instance（通过 /enter 接口）
# 2. 再次调用 /enter，验证返回 reused
# 3. 测试 maxSessions 限制
# 4. 测试 autoStart 场景
# 5. IMChannel 消息到达时自动 spawn
```

## 依赖关系

- 独立可实施
- 与 Plan 02、Plan 03 可并行
