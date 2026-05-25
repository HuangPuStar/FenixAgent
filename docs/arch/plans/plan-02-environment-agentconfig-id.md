# Plan 02：Environment 引用 AgentConfig 改为 ID 强绑定

## Context

当前 Environment 通过 `agentName`（字符串）匹配 AgentConfig 的 `name`。如果 AgentConfig 改名，Environment 会找不到配置。需要改为通过 AgentConfig 的 `id`（UUID）强绑定。

## 现状分析

### 当前引用方式

- `src/db/schema.ts`：environment 表有 `agentName: varchar("agent_name")` 字段
- `src/services/instance.ts:218-219`：`configPg.getAgentConfig(userId, env.agentName)` 通过 name 查找
- `src/routes/web/environments.ts`：创建/更新时验证 `agentName` 存在性
- `web/src/pages/EnvironmentsPage.tsx`：Agent 选择使用 name 字符串匹配

### 涉及文件

**后端**：

| 文件 | 改动说明 |
|------|----------|
| `src/db/schema.ts` | environment 表新增 `agentConfigId` 列（UUID，references agentConfig.id） |
| `src/db/migrations/` | 新增迁移文件 |
| `src/services/instance.ts` | `spawnInstanceFromEnvironment()` 改用 `env.agentConfigId` 查找 |
| `src/routes/web/environments.ts` | 创建/更新接口接受 `agentConfigId` |
| `src/services/config-pg.ts` | 新增 `getAgentConfigById(id)` 方法 |

**前端**：

| 文件 | 改动说明 |
|------|----------|
| `web/src/pages/EnvironmentsPage.tsx` | Agent 选择器改为 ID 选择器 |

### 数据迁移策略

1. 新增 `agentConfigId` 列（nullable，过渡期两列并存）
2. 迁移脚本：根据现有 `agentName` 填充 `agentConfigId`
3. 过渡期 API 同时支持 `agentName`（兼容）和 `agentConfigId`（优先）
4. 前端完全切换后，移除 `agentName` 兼容逻辑

## 具体实施步骤

### Step 1：数据库 Schema 变更

```typescript
// src/db/schema.ts - environment 表
agentConfigId: uuid("agent_config_id").references(() => agentConfig.id),
// agentName 列保留，标记为 deprecated
```

### Step 2：后端服务层

```typescript
// src/services/config-pg.ts - 新增
async function getAgentConfigById(id: string): Promise<AgentConfig | null>

// src/services/instance.ts - 修改 spawnInstanceFromEnvironment
const agentConfig = env.agentConfigId
  ? await getAgentConfigById(env.agentConfigId)
  : await getAgentConfig(userId, env.agentName); // 兼容过渡
```

### Step 3：路由层

```typescript
// src/routes/web/environments.ts
// POST /web/environments - 创建时接受 agentConfigId
// PUT /web/environments/:id - 更新时接受 agentConfigId
// 验证: agentConfigId 存在性检查
```

### Step 4：前端

```typescript
// web/src/pages/EnvironmentsPage.tsx
// Agent 下拉改为: 从 API 获取 agentConfig 列表，选中后存储 ID
```

### Step 5：数据迁移脚本

- 查询所有 environment 记录
- 根据 agentName 查找对应的 agentConfig.id
- 更新 agentConfigId 字段
- 处理找不到匹配的 orphan 记录

## 验证方式

```bash
# 单元测试
bun test src/__tests__/

# 手动验证
# 1. 启动 dev server
bun run dev
# 2. 创建 Environment 时选择 AgentConfig（ID 选择器）
# 3. 验证 environment 记录中 agentConfigId 正确存储
# 4. 修改 AgentConfig name 后，Environment 仍能正确关联
```

## 依赖关系

- 独立可实施
- Plan 01（文档更新）无硬依赖，可并行
