# 机器预注册与激活

> 状态: 设计完成 | 日期: 2026-07-08

## 背景

当前机器注册流程中，任何持有 `REGISTRY_SECRET` 的客户端都可以自行注册为 machine，server 自动分配 ID。这导致 machine id 不可预测，也无法在注册前进行权限控制和审计。

需要改为 **预注册 + 激活** 模式：组织管理员在 RCS 中预先创建机器记录，获取固定的 machine id 和初始化命令，再将命令下发给机器管理员执行。

## 目标

1. **组织管理员预创建机器** — 通过 UI/API 创建机器记录，生成初始化命令
2. **系统启动注入** — RCS 环境变量指定的机器在启动时自动预创建
3. **客户端凭证激活** — 客户端使用预分配的 `RCS_MACHINE_ID` 注册，服务端激活已有记录

## 不改的内容

- `REGISTRY_SECRET` 的鉴权机制不变（WS 连接认证）
- 心跳、断连、重连、sweep 机制不变
- `RCS_DEFAULT_MACHINE_ID` 和 `RCS_DISABLE_LOCAL_EXECUTION` 的 fallback 行为不变
- 当前已有的 `machineId` 去重分支功能保留，改为仅处理 `pending` / `offline` → `online` 激活

---

## 设计

### 1. 机器生命周期状态机

```
pending ──首次注册──→ online ──断连──→ offline ──重连──→ online
  │                      │                      │
  └── 管理员删除 ──→ (记录删除)                └── 管理员删除 ──→ (记录删除)
```

| 状态 | 含义 | 可注册? |
|------|------|:---:|
| `pending` | 管理员已创建，等待客户端首次连接 | ✅ 首次激活 |
| `online` | 在线，正常工作 | ❌ 拒绝 |
| `offline` | 断连，等待重连 | ✅ 重连激活 |

### 2. 创建机器 API

`POST /web/registry/machines`

**请求**：

```json
{
  "name": "sandbox-01",
  "labels": ["sandbox", "production"],
  "engineType": "opencode"
}
```

**响应**：

```json
{
  "success": true,
  "data": {
    "id": "mach_a1b2c3d4e5f6g7h8i9j0",
    "name": "sandbox-01",
    "status": "pending",
    "initCommand": "RCS_MACHINE_ID=mach_a1b2c3d4e5f6g7h8i9j0 RCS_SECRET=xxx AGENT_TYPE=opencode acp-runtime opencode acp"
  }
}
```

**DB 操作**：`INSERT INTO machine (id, organizationId, name, labels, agentName, status='pending', ...)`

### 3. 系统启动注入

在 `src/services/core-bootstrap.ts` 的启动流程中新增：

```typescript
// RCS_DEFAULT_MACHINE_ID 有值时，确保 DB 中存在对应的 machine 记录
if (config.defaultMachineId) {
  await ensureMachineExists(config.defaultMachineId, config.defaultEngineType);
}
```

`ensureMachineExists` 逻辑：
- 查询 `WHERE id = config.defaultMachineId`
- 不存在 → INSERT（status=pending, orgId=NULL, agentName=defaultEngineType）
- 存在 → 不操作（保留现有记录，可能是管理员已手动创建的）

### 4. registerMachine 改动

**原有分支调整**：

```
registerMachine(params)
  │
  ├── params.machineId 有值？
  │     ├── 是 → 查询 DB WHERE id = params.machineId
  │     │         ├── 不存在 → 抛错 "machine not found"
  │     │         ├── status = "pending" → 首次激活
  │     │         │   └── UPDATE status=online + 写入 register 事件 + bindAgentConfigs
  │     │         ├── status = "online" → 抛错 "already online"
  │     │         └── status = "offline" → 重连激活
  │     │             └── UPDATE status=online + 写入 reconnect 事件 + bindAgentConfigs
  │     │
  │     └── 否 → 走现有逻辑（node_id / hostname 去重）（兼容未迁移的客户端）
```

**注意**：不设置 `RCS_MACHINE_ID` 的旧客户端仍然兼容（走 node_id 去重），但推荐所有客户端迁移到设置 `RCS_MACHINE_ID` 的模式。

### 5. 不变的部分

- 注册成功后：`registerRemoteNode()` → Core 节点注册
- 心跳：`startHeartbeat()` → 90s 超时
- 断连：`disconnectMachine()` → status=offline
- Sweep 巡检：60s 清理幽灵记录
- `bindAgentConfigs()`：注册成功后自动绑定同名 agent config

### 6. 文件改动清单

| 文件 | 改动 |
|------|------|
| `src/schemas/registry.schema.ts` | 新增 `CreateMachineSchema`（name, labels, engineType） |
| `src/services/registry.ts` | 新增 `createMachine()`；`registerMachine` 新增 `pending` 状态处理 |
| `src/routes/web/registry.ts` | 新增 `POST /web/registry/machines` |
| `src/services/core-bootstrap.ts` | 启动时 `ensureMachineExists(config.defaultMachineId)` |
| web 前端 | registry 页面新增「创建机器」按钮和表单 |

### 7. 边界行为

| 场景 | 预期行为 |
|------|----------|
| 管理员创建机器 | DB INSERT，status=pending，返回 ID + 初始化命令 |
| ID 不存在 | 服务端返回 "machine not found" |
| ID 存在 + status = `pending` | 首次激活 → online，写 register 事件 |
| ID 存在 + status = `online` | 拒绝，返回 "already online" |
| ID 存在 + status = `offline` | 重连激活 → online，写 reconnect 事件 |
| 管理员删除机器 | 硬删除 DB 记录；该 client 下次注册时报 "not found" |
| 系统启动注入 | 不存在时自动创建 pending 记录；已存在时不动 |
| `RCS_MACHINE_ID` 未设置 | 走现有 node_id / hostname 去重逻辑（兼容） |

### 8. 测试计划

- **创建机器 API 测试**：正常创建、参数校验、组织隔离
- **registerMachine 测试**：pending 激活、online 拒绝、offline 重连、ID 不存在
- **启动注入测试**：`ensureMachineExists` 新建和已存在两种场景
- **端到端**：管理员创建 → 客户端注册 → 实例启动完整链路
