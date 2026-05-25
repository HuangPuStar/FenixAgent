# Plan 10：Model 合并进 Provider，Skill/McpServer/Provider 定位为独立资源

## Context

Model 当前作为独立领域概念存在，Skill/McpServer/Provider 在领域图中被画在 AgentConfig 的 subgraph 内。需要：
1. Model 合并到 Provider 内部（概念层面）
2. Skill、McpServer、Provider 与 AgentConfig 处于同一层级（引用关系）

## 现状分析

### 当前数据模型

| 表 | 定位 |
|----|------|
| `provider` | 独立表，userId + name |
| `model` | 独立表，userId + name + providerName |
| `skill` | 独立表，但在领域图中被画在 AgentConfig subgraph 内 |
| `mcp_server` | 独立表，同上 |
| `agent_config` | 引用 model name |

### 改动范围

本次主要是**概念层面和文档层面**的调整，数据表结构不变：

- `model` 表保留（数据层面不变）
- Model 的 CRUD 逻辑保持不变（作为 Provider 的子资源管理）
- 前端 Model 管理入口放在 Provider 详情页内
- 领域图中移除 Model 独立节点

### 涉及文件

**文档**：

| 文件 | 改动 |
|------|------|
| `docs/arch/16-domain-model.md` | 更新领域图，Provider 包含 Model |
| `docs/arch/06-config.md` | 更新配置关系说明 |

**前端**：

| 文件 | 改动 |
|------|------|
| `web/src/pages/ModelsPage.tsx` | 改为 Provider 详情内的子页面/Tab |
| `web/src/pages/ProvidersPage.tsx` | 新增 Model 管理 Tab |
| `web/src/pages/AgentsPage.tsx` | Model 选择器改为 Provider→Model 两级选择 |
| 路由配置 | `/ctrl/models` 可能重定向到 Provider 详情 |

**后端**：

| 文件 | 改动 |
|------|------|
| `src/services/config-pg.ts` | 保持不变（Model 仍是 Provider 的子资源） |
| `src/routes/web/config.ts` | 保持不变 |

## 具体实施步骤

### Step 1：领域文档更新

- 领域图：Provider 节点内标注"包含 Model"
- 领域图：Skill、McpServer、Provider 与 AgentConfig 同层级
- 概念卡片：Provider/Model 合并为一张卡片

### Step 2：前端路由调整

```
/ctrl/providers/:name/models  — Provider 下的 Model 列表
/ctrl/models                  — 重定向到 /ctrl/providers
```

### Step 3：Provider 详情页增强

- 新增 Models Tab
- Model 的 CRUD 操作放在 Provider 详情页内
- AgentConfig 的 Model 选择器改为两级（先选 Provider，再选 Model）

### Step 4：领域关系可视化

- Skill、McpServer、Provider 与 AgentConfig 用虚线标注"引用"关系
- 移除"包含/聚合"视觉暗示

## 验证方式

```bash
# 前端测试
bun test web/src/__tests__/

# 手动验证
bun run dev:web
# 1. Provider 详情页显示 Models Tab
# 2. 在 Provider 内创建/编辑/删除 Model
# 3. AgentConfig 配置中 Model 选择器改为两级
# 4. 原有 /ctrl/models 路由重定向正常
```

## 依赖关系

- 独立可实施
- 主要是文档和前端改动，后端逻辑不变
