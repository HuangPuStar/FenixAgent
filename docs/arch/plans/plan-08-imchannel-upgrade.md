# Plan 08：IMChannel 升级为用户资源

## Context

当前 ChannelBinding 是独立的路由规则表，Hermes 是外部网关，两者在代码中分离。需要将 IMChannel 升级为用户界面的一等资源，统一管理连接方式、路由规则和运行时状态。

## 现状分析

### 当前架构

| 文件 | 职责 |
|------|------|
| `src/db/schema.ts` (channelBinding) | platform + chatId → agentId 路由规则 |
| `src/services/channel-binding.ts` | 绑定 CRUD + 消息匹配 |
| `src/services/hermes-client.ts` | Hermes WS 连接 + 消息路由 |
| `src/routes/web/channels.ts` | 绑定 CRUD + Hermes 状态查询 |
| `web/src/pages/ChannelsPage.tsx` | Channel 管理 UI |

### 目标 IMChannel 概念

用户创建一个 IMChannel 时配置：
- **连接方式**：选择平台（飞书/Telegram/Discord）+ 填写凭证
- **路由规则**：聊天群 → Agent（Environment）的映射
- **运行时状态**：已连接 / 未连接 / 错误

### 涉及文件

**后端**：

| 文件 | 改动 |
|------|------|
| `src/db/schema.ts` | 新增 `im_channel` 表或重构 `channel_binding` 表 |
| `src/services/channel-binding.ts` | 逻辑融入 IMChannel 服务 |
| `src/services/hermes-client.ts` | 成为 IMChannel 的底层传输实现 |
| `src/routes/web/channels.ts` | 升级为 IMChannel 完整 CRUD + 连接管理 |
| `src/services/im-channel.ts` | 新增 IMChannel 服务（可选，或在 channel-binding.ts 中重构） |

**前端**：

| 文件 | 改动 |
|------|------|
| `web/src/pages/ChannelsPage.tsx` | IMChannel 管理界面重设计 |

## 具体实施步骤

### Step 1：数据库表设计

```sql
-- IMChannel 表（替代/扩展 channel_binding）
CREATE TABLE im_channel (
  id UUID PRIMARY KEY,
  team_id UUID NOT NULL,
  name VARCHAR NOT NULL,
  platform VARCHAR NOT NULL,         -- feishu/telegram/discord
  credentials JSONB NOT NULL,        -- 平台凭证（加密存储）
  status VARCHAR DEFAULT 'disconnected', -- connected/disconnected/error
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

-- 路由规则表（扩展 channel_binding）
-- 新增 im_channel_id 外键
-- 或合并到 im_channel 的 JSONB 字段
```

### Step 2：IMChannel 服务

```typescript
// src/services/im-channel.ts
interface IMChannelService {
  // CRUD
  create(userId, data): Promise<IMChannel>;
  list(userId): Promise<IMChannel[]>;
  update(userId, id, data): Promise<IMChannel>;
  delete(userId, id): Promise<void>;

  // 连接管理
  connect(channelId): Promise<void>;
  disconnect(channelId): Promise<void>;
  getStatus(channelId): Promise<ChannelStatus>;

  // 路由规则
  addRoute(channelId, route): Promise<void>;
  removeRoute(channelId, routeId): Promise<void>;
}
```

### Step 3：Hermes 集成

```typescript
// src/services/hermes-client.ts
// 成为 IMChannel 的底层传输
// IMChannel.connect() → 初始化 Hermes 连接
// IMChannel.disconnect() → 断开 Hermes
// 用户不直接接触 Hermes
```

### Step 4：路由升级

```typescript
// src/routes/web/channels.ts
// POST   /web/channels           — 创建 IMChannel
// GET    /web/channels           — 列表
// PUT    /web/channels/:id       — 更新配置
// DELETE /web/channels/:id       — 删除
// POST   /web/channels/:id/connect    — 建立连接
// POST   /web/channels/:id/disconnect — 断开连接
// GET    /web/channels/:id/status     — 连接状态
// POST   /web/channels/:id/routes     — 添加路由规则
// DELETE /web/channels/:id/routes/:routeId — 删除路由规则
```

### Step 5：前端重设计

- IMChannel 列表页：展示连接状态、平台图标
- 创建/编辑表单：平台选择 + 凭证配置 + 路由规则
- 连接状态实时更新

## 验证方式

```bash
# 单元测试
bun test src/__tests__/

# 集成验证
bun run dev
# 1. 创建 IMChannel（选择平台，配置凭证）
# 2. 添加路由规则
# 3. 连接 IMChannel，验证状态变为 connected
# 4. 发送测试消息，验证路由到正确 Agent
```

## 依赖关系

- 独立可实施
- Plan 11（Team）可在之后集成（添加 teamId）
