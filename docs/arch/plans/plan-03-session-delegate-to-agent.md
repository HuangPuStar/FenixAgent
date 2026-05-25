# Plan 03：Session 下沉到 Agent 进程，RCS 完全透传

## Context

Session 当前是 RCS 的一等公民：有独立 DB 表（`agent_session`）、仓储（`SessionRepo`）、路由（`/web/sessions`）、Service 层（`session.ts`）。目标是将 Session 管理下沉到 Agent 进程（acp-link），RCS 不存储、不管理 Session，只做消息透传。

## 现状分析

### 当前 Session 架构

| 层级 | 文件 | 职责 |
|------|------|------|
| DB | `src/db/schema.ts` (agentSession) | session 元数据持久化 |
| Repository | `src/repositories/session.ts` | 双存储（内存 Map + PG），生命周期管理 |
| Service | `src/services/session.ts` | CRUD + 状态追踪 + 事件发布 |
| Route | `src/routes/web/sessions.ts` | REST API：list/get/history |
| Transport | `src/transport/acp-relay-handler.ts` | relay 的 sessionId 用于实例路由 |
| Frontend | `web/src/pages/SessionDetail.tsx` | Session 展示 |
| Frontend | `web/src/acp/client.ts` | ACP 协议客户端 |

### 关键发现

1. **ACP 协议已支持 session/list**：前端通过 ACP 通道可以直接从 Agent 获取 Session 列表
2. **relay handler 的 sessionId**：用于实例路由匹配（`findInstanceBySessionId`），与 Session 元数据管理是两个概念
3. **EventBus 按 session 组织**：`getEventBus(sessionId)` 用于 UI SSE 推送，需要保留但语义变化
4. **文件系统按 Session 组织**：`/web/sessions/:id/user/*` 需要改为按 Environment 维度

### 涉及文件

**后端 - 废弃/简化**：

| 文件 | 改动 |
|------|------|
| `src/db/schema.ts` | `agentSession` 表标记废弃（不删除，降级为轻量缓存） |
| `src/repositories/session.ts` | 大幅简化，只保留 EventBus 关联所需的轻量记录 |
| `src/services/session.ts` | 移除大部分逻辑，保留 SSE 推送所需的最小接口 |
| `src/routes/web/sessions.ts` | 改为 ACP 透传代理（转发 session/list 到 Agent） |

**后端 - 修改**：

| 文件 | 改动 |
|------|------|
| `src/services/instance.ts` | 不再在 spawn 时创建/查找 Session |
| `src/transport/acp-relay-handler.ts` | sessionId 语义变化，变为前端与 Agent 协商的标识 |
| `src/routes/web/environments.ts` | 文件系统路由改为 Environment 维度 |
| `src/routes/web/files.ts` 或文件路由 | `/web/sessions/:id/user/*` → `/web/environments/:id/user/*` |

**前端 - 修改**：

| 文件 | 改动 |
|------|------|
| `web/src/pages/SessionDetail.tsx` | Session 列表从 ACP session/list 获取 |
| `web/src/acp/client.ts` | 增强 ACP Session 管理 |
| `web/src/api/client.ts` | 移除/简化 Session API 调用 |

## 具体实施步骤

### Step 1：Session 路由改为 ACP 透传

```typescript
// src/routes/web/sessions.ts
// GET /web/sessions → 转发 ACP session/list 到所有在线 Agent
// GET /web/sessions/:id → 转发 ACP session/load 到对应 Agent
```

### Step 2：简化 Session Service/Repository

- 移除 `createSession()`、`updateSessionStatus()`、`archiveSession()` 等管理逻辑
- 保留 `getEventBus(sessionId)` 用于 SSE 推送
- Session 记录降级为"连接上下文缓存"，不存储业务元数据

### Step 3：Instance spawn 移除 Session 创建

```typescript
// src/services/instance.ts
// spawnInstanceFromEnvironment() 不再调用 createSession()
// Session 由 acp-link 进程自行管理
```

### Step 4：文件系统路由迁移

```
/web/sessions/:sessionId/user/* → /web/environments/:envId/user/*
```

- 文件存储从 session 维度改为 environment 维度
- 前端 FilePickerDialog 的路径参数同步更新

### Step 5：前端 Session 列表改用 ACP

```typescript
// 从 ACP session/list 获取 session 列表
// 不再调用 GET /web/sessions
```

### Step 6：agentSession 表降级

- 不删除表（兼容现有数据）
- 新代码不再写入该表
- 添加注释标记为 deprecated

## 验证方式

```bash
# 单元测试
bun test src/__tests__/

# 集成验证
bun run dev
# 1. Session 列表页正常显示（来自 ACP session/list）
# 2. 创建新 Session 后能正常加载
# 3. 文件上传/浏览按 Environment 维度工作
# 4. SSE 事件推送正常
```

## 风险点

1. **ACP Agent 离线时无 Session 数据**：需要处理 Agent 离线场景的 UI 展示
2. **文件系统迁移**：已有 session 维度的文件需要迁移到 environment 维度
3. **EventBus 兼容**：SSE 推送依赖 session-scoped EventBus，需确保透传后不丢失

## 依赖关系

- 建议在 Plan 02（agentConfigId）之后实施，因为 spawn 逻辑会简化
- Plan 04（spawn 决策统一）可并行
