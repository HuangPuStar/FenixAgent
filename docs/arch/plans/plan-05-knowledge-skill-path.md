# Plan 05：KnowledgeBase 和 Skill 的关联路径明确化

## Context

KnowledgeBase 和 Skill 当前关联路径模糊。需要明确两条路径：
1. **KnowledgeBase → MCP → AgentConfig**：KB 通过 MCP 协议关联 AgentConfig
2. **Skill → AgentConfig**：Skill 直接绑定 AgentConfig

## 现状分析

### 当前关联方式

| 资源 | 关联路径 | 代码位置 |
|------|----------|----------|
| KnowledgeBase | `agent_knowledge_binding` 表 → AgentConfig | `src/services/config-pg.ts` |
| KnowledgeBase MCP 注入 | `instance.ts` spawn 时注入 MCP knowledge 端点 | `src/services/instance.ts:230-242` |
| Skill | 元数据在 DB（skill 表），内容在文件系统 | `src/services/config-pg.ts:279-373` |
| Skill 与 AgentConfig | 无直接关联，全局共享 | 无 |

### 关键发现

1. **KnowledgeBase 已通过 AgentConfig 关联**：`agent_knowledge_binding` 表和 `knowledge` JSONB 字段已存在
2. **Skill 没有绑定 AgentConfig**：当前 Skill 是全局的，所有 Agent 共享
3. **instance.ts 的 KB 注入逻辑**：spawn 时读取 AgentConfig 的 knowledge 绑定，注入 MCP 端点

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/services/instance.ts` | 简化 spawn 逻辑，只传递 AgentConfig 完整配置 |
| `src/db/schema.ts` | skill 表新增 `agentConfigId` 列（可选，null=全局） |
| `src/services/config-pg.ts` | Skill CRUD 支持 agentConfigId 过滤 |
| `docs/arch/16-domain-model.md` | 更新领域图，KB 和 Skill 直接连线到 AgentConfig |
| `docs/arch/11-knowledge.md` | 更新 Knowledge 关联路径说明 |

## 具体实施步骤

### Step 1：Skill 绑定 AgentConfig

```typescript
// src/db/schema.ts - skill 表新增
agentConfigId: uuid("agent_config_id").references(() => agentConfig.id),
```

- `agentConfigId = null`：全局 Skill，所有 Agent 可用
- `agentConfigId = "xxx"`：专属 Skill，仅该 Agent 使用

### Step 2：简化 instance.ts 的 spawn 注入

```typescript
// src/services/instance.ts - spawnInstanceFromEnvironment()
// 不再特殊处理 KB MCP 端点
// 只需把 AgentConfig 的完整配置（包括 MCP 和 Skill 引用）写入 workspace
```

### Step 3：Config 服务更新

```typescript
// src/services/config-pg.ts
// listSkills(userId, agentConfigId?) - 支持按 agentConfigId 过滤
// 返回全局 Skill + 指定 Agent 的专属 Skill
```

### Step 4：领域文档更新

- KB 和 Skill 都直接连线到 AgentConfig
- Environment 不再作为 KB/Skill 的中转

## 验证方式

```bash
# 单元测试
bun test src/__tests__/

# 集成验证
bun run dev
# 1. 创建 Agent 专属 Skill
# 2. 验证 spawn 时 Agent 只获取全局 + 专属 Skill
# 3. KnowledgeBase MCP 注入正常工作
```

## 依赖关系

- 建议在 Plan 02（agentConfigId）之后实施
- 可与 Plan 03 并行
