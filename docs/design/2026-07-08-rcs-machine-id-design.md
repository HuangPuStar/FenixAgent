# RCS_MACHINE_ID 固定机器标识

> 状态: 设计完成 | 日期: 2026-07-08

## 背景

当前 machine 注册到 RCS 时，machine id 由服务端自动生成（格式 `mach_xxx`），客户端通过 `.acp-link-node-id` 持久化后重连时精确匹配。但这种方式下 machine id 不可预测，无法在系统级配置（如 `RCS_DEFAULT_MACHINE_ID`）中固定引用。

需要支持客户端通过环境变量 `RCS_MACHINE_ID` 主动指定注册使用的 machine id，让运维侧可以预先规划并固定 ID。

## 目标

通过新增 `RCS_MACHINE_ID` 环境变量，客户端可以指定注册时使用的 machine id，实现：

1. **固定 ID 注册**：客户端指定 ID 后，后端使用该 ID 创建或接管 machine 记录
2. **全局可见**：配合 `RCS_TENANT_ID` 不设置的情况，machine 的 `organizationId` 为 NULL，所有组织可见
3. **与 `RCS_DEFAULT_MACHINE_ID` 闭环**：客户端固定 ID + 服务端默认 fallback → 完整链路

## 不改的内容

- 不设置 `RCS_MACHINE_ID` 时，现有注册逻辑完全不变
- online 状态的 machine 不允许被另一个 client 接管，返回错误
- 不影响现有的 `.acp-link-node-id` 持久化机制（注册成功后依然写入）

---

## 设计

### 1. 客户端环境变量

在 `packages/acp-runtime-cli/src/bin.ts` 新增：

```typescript
const MACHINE_ID = process.env.RCS_MACHINE_ID;
```

- 可选，格式 `mach_xxx`
- 不设置时走现有逻辑

`startServer` 调用新增参数：

```typescript
await startServer({
  // ... 现有参数 ...
  machineId: MACHINE_ID ?? undefined,
});
```

### 2. ServerConfig 扩展

`packages/acp-link/src/server.ts` 的 `ServerConfig` 新增字段：

```typescript
export interface ServerConfig {
  // ... 现有字段 ...
  /** 客户端指定的 machine id（可选），用于固定 machine 标识 */
  machineId?: string;
}
```

`buildRegisterMessage` 在消息体中携带：

```typescript
if (config.machineId) {
  msg.machine_id = config.machineId;
}
```

### 3. 服务端注册消息解析

`src/transport/acp-ws-handler.ts` 解析新增字段：

```typescript
const specifiedMachineId = (msg.machine_id as string) || null;
```

传入 `registerMachine`：

```typescript
const result = await registerMachine({
  // ... 现有参数 ...
  machineId: specifiedMachineId,
});
```

### 4. registerMachine 扩展

`src/services/registry.ts` 的 `registerMachine` 新增参数：

```typescript
export async function registerMachine(params: {
  // ... 现有参数 ...
  /** 客户端指定的 machine id（可选），有值时跳过 ID 生成和去重，直接用该 ID */
  machineId?: string | null;
}): Promise<{ id: string; isNew: boolean }> {
```

**核心逻辑**：

```
params.machineId 有值？
    │
    ├── 否 → 走现有去重 + 自动生成 ID 逻辑（完全不变）
    │
    └── 是 → 查询 DB WHERE id = params.machineId
              ├── 不存在 → INSERT id=machineId, organizationId=tenantId, ...
              │              isNew = true
              │              注册成功后持久化 node_id 到 .acp-link-node-id
              │
              ├── 存在 + status = "offline" → UPDATE status=online, organizationId=tenantId, ...
              │                                  isNew = false（接管已有记录，orgId 同步更新）
              │
              └── 存在 + status = "online" → throw Error("machine id 'xxx' is already online")
                                               client 收到错误后退出
```

### 5. 完整流程示意

```
docker/sandbox 容器
    │
    ├── RCS_MACHINE_ID=mach_sandbox_01  （固定 ID）
    ├── RCS_TENANT_ID 不设置            （全局可见）
    │
    ↓ register { machine_id: "mach_sandbox_01", tenant_id: null, ... }
    │
    │   首次启动：DB 中无 mach_sandbox_01 → INSERT（orgId=NULL, 所有组织可见）
    │   后续重启：DB 中有 + offline → UPDATE（接管，orgId 同步为 NULL）
    │   重复启动：DB 中有 + online → 拒绝，client 退出
    │
    ↓ 注册成功后持久化 .acp-link-node-id = "mach_sandbox_01"
    │
RCS 服务端
    │
    ├── RCS_DEFAULT_MACHINE_ID=mach_sandbox_01  → agent 实例路由到 sandbox
    │
    └── DB 中 organizationId=NULL → 所有 org 可见，org 隔离的查询条件覆盖
```

### 6. 文件改动清单

| 文件 | 改动 |
|------|------|
| `packages/acp-runtime-cli/src/bin.ts` | 读取 `RCS_MACHINE_ID`，传给 `startServer` |
| `packages/acp-link/src/server.ts` | `ServerConfig.machineId`；`buildRegisterMessage` 携带 `machine_id` |
| `src/transport/acp-ws-handler.ts` | 解析 `machine_id` 字段，传入 `registerMachine` |
| `src/services/registry.ts` | `registerMachine` 新增 `machineId` 参数和逻辑分支 |

### 7. 边界行为

| 场景 | 预期行为 |
|------|----------|
| `RCS_MACHINE_ID` 未设置 | 完全走现有逻辑，无影响 |
| ID 不存在（首次注册） | INSERT 新记录，`id` 为指定值，`isNew=true` |
| ID 存在 + `status=offline` | UPDATE 接管，`organizationId` 同步为当前 `tenantId` |
| ID 存在 + `status=online` | 返回错误，client 退出（不允许多 client 共用同一 ID） |
| ID 格式非法 | 不做校验，由数据库约束兜底 |
| 指定 ID 注册后，改为不指定 ID 重启 | `.acp-link-node-id` 持久化了上次的 ID，走 nodeId 精确匹配，行为同"ID 存在 + offline" |

### 8. 测试计划

- **客户端测试**：验证 `RCS_MACHINE_ID` 读取、`buildRegisterMessage` 携带 `machine_id`
- **注册服务测试**：覆盖指定 ID 的三种分支（不存在/offline 接管/online 拒绝）
- **端到端**：sandbox 容器设 `RCS_MACHINE_ID` + `RCS_DEFAULT_MACHINE_ID` 完整链路
