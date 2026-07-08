# 系统级默认 Machine 与 Agent Type 指定

> 状态: 设计完成 | 日期: 2026-07-08

## 背景

当前 FenixAgent 的实例启动流程中，当 agent config 未绑定 machineId 时，系统固定落到 `local-default` 节点（进程内本地执行）；当 agent config 未指定 engineType 时，固定使用 `"opencode"`。这导致在部署场景下无法通过系统级别环境变量将"本地执行"重定向到指定远程机器，也无法统一覆盖默认引擎类型。

## 目标

通过两个系统环境变量，在 agent config 未显式指定时提供 fallback，实现：

1. **Machine fallback**：agent config `machineId` 为空时，使用 `RCS_DEFAULT_MACHINE_ID` 指定的远程机器，而非 `local-default`
2. **Engine type fallback**：agent config `engineType` 为空时，使用 `RCS_DEFAULT_ENGINE_TYPE` 指定的引擎类型，而非硬编码 `"opencode"`

## 不改的内容

- agent config 显式指定了 machineId / engineType 时，环境变量不覆盖（agent config 优先级最高）
- fallback machine 离线时不降级到 local-default，直接报错
- 远程机器执行的全部生命周期（prepare/start/stop/relay/心跳）不变
- 前端 UI 无改动

---

## 设计

### 1. 环境变量

在 `src/env.ts` 的 `envSchema` 中新增：

```typescript
// 默认 fallback 机器 ID。agent config 未绑定 machineId 时使用此机器替代 local-default
RCS_DEFAULT_MACHINE_ID: z
  .string()
  .regex(/^mach_/, "RCS_DEFAULT_MACHINE_ID must start with 'mach_'")
  .optional(),

// 默认引擎类型。agent config 未指定 engineType 时覆盖默认值
RCS_DEFAULT_ENGINE_TYPE: z.enum(ENGINE_TYPES).optional(),
```

`ENGINE_TYPES` 从 `src/services/config/types.ts` 引入（值为 `["opencode", "ccb", "claude-code"]`）。

同时移除现有未使用的 `RCS_ENGINE_TYPE` 变量。

### 2. 配置传递（`src/config.ts`）

在 `buildConfig` 中新增两个字段：

```typescript
defaultMachineId: env.RCS_DEFAULT_MACHINE_ID,
defaultEngineType: env.RCS_DEFAULT_ENGINE_TYPE,
```

相应更新 `AppConfig` 类型（`ReturnType<typeof buildConfig>` 自动推导，无需手动声明）。

### 3. 核心逻辑改动（`src/services/instance.ts`）

#### 3.1 Machine fallback 决策

修改 `spawnInstanceFromEnvironment` 的 `nodeId` 赋值逻辑：

**当前（第 249-253 行）：**
```typescript
let nodeId = "local-default";
if (agentMachineId) {
  nodeId = agentMachineId;
}
```

**改为：**
```typescript
let nodeId = "local-default";
if (agentMachineId) {
  nodeId = agentMachineId;
} else if (config.defaultMachineId) {
  nodeId = config.defaultMachineId;
}
```

后续在线检查（`nodeId !== "local-default"` 分支）无需改动，自动覆盖 fallback machine 场景。离线时抛出 `MACHINE_OFFLINE` 错误。

**优先级**：agent config 绑定 > `RCS_DEFAULT_MACHINE_ID` > `local-default`

#### 3.2 Engine type 默认值

修改 `spawnInstanceFromEnvironment` 中的 engineType 取值（第 265 行）：

**当前：**
```typescript
const engineType = (resolvedAgentConfig as Record<string, unknown> | null)?.engineType ?? "opencode";
```

**改为：**
```typescript
const engineType = (resolvedAgentConfig as Record<string, unknown> | null)?.engineType 
  ?? config.defaultEngineType 
  ?? "opencode";
```

**优先级**：agent config 指定 > `RCS_DEFAULT_ENGINE_TYPE` > `"opencode"`

`config` 通过已有的 `../config` 导入路径访问。

### 4. 文件改动清单

| 文件 | 改动 |
|------|------|
| `src/env.ts` | 新增两个变量，移除 `RCS_ENGINE_TYPE` |
| `src/config.ts` | `buildConfig` 新增两个字段 |
| `src/services/instance.ts` | 修改 `nodeId` 和 `engineType` 决策逻辑 |
| `src/__tests__/` | 新增 env 校验测试、instance fallback 测试 |
| 现有测试文件（如有引用 `RCS_ENGINE_TYPE`） | 清理旧引用 |

### 5. 边界行为

| 场景 | 预期行为 |
|------|----------|
| 两个变量均未设置 | 完全向后兼容，等同现状 |
| fallback machine 离线 | 抛出 `MACHINE_OFFLINE`（503），不复用现有错误码 |
| `RCS_DEFAULT_MACHINE_ID` 格式非法 | 启动时 env 校验失败，进程退出 |
| `RCS_DEFAULT_ENGINE_TYPE` 非法值 | 启动时 env 校验失败，进程退出 |
| agent config 显式指定 machineId / engineType | 环境变量不生效，agent config 优先 |
| fallback machine 在线 | 走完整远程执行分支（prepare → start → relay → stop） |

### 6. 测试计划

- **env 校验测试**：验证 `RCS_DEFAULT_MACHINE_ID` `mach_` 前缀正则、`RCS_DEFAULT_ENGINE_TYPE` 枚举约束
- **instance 单元测试**：覆盖四象限
  - 有 agent config 绑定 machineId → 使用 agent config 的 machineId
  - 无绑定 + env 有设置 → 使用 env fallback machine
  - 无绑定 + env 未设置 → 使用 local-default（向后兼容）
  - env 有设置但机器离线 → 抛出 MACHINE_OFFLINE
- 复用 `src/test-utils/` 中的 `setConfig` / `setTestAuth` 等工具

### 7. 不做的

- 不提供按 engine type 分别路由不同机器（只做单变量全局 fallback）
- 不在前端增加配置 UI（系统运维级别配置，应通过部署环境变量管理）
- 不修改 agent config 的 DB schema
- 不修改远程机器的注册/心跳/生命周期流程
