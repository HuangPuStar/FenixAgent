# Hindsight 记忆模块架构

## 概述

Hindsight 是外部部署的 AI 长期记忆服务（MIT 开源，Vectorize 出品），Agent 会话中产生的记忆由 Hindsight 存储与召回。FenixAgent 通过 OpenCode 插件与其集成，实现记忆的**自动读写**。

**核心机制**：RCS 为每个用户创建独立的 Hindsight Bank → Agent 运行时通过 OpenCode 插件自动 recall/retain → 前端 ChatPanel 以紫色卡片渲染记忆工具调用。

> **历史决策**：MCP 工具路径（hindsight_recall / hindsight_retain / hindsight_reflect）已废弃。统一通过 OpenCode 插件路径接入。

```
┌──────────────────────────────────────────────────────┐
│                    Agent 会话                         │
│                                                      │
│  OpenCode Agent (插件路径)                             │
│  ┌─────────────────────────────────────────────────┐ │
│  │ @konghayao/opencode-hindsight                   │ │
│  │ ├─ autoRecall  = true   (每次提问前自动召回)     │ │
│  │ ├─ autoRetain  = true   (回复后自动保存)         │ │
│  │ ├─ retainEveryNTurns: 3 (每 N 轮触发)           │ │
│  │ └─ recallBudget: "mid"  (召回详略程度)           │ │
│  └────────────────────┬────────────────────────────┘ │
│                       ↓                              │
│             RCS 反向代理 /web/hindsight                │
│                       ↓                              │
│             外部 Hindsight 服务 (Docker)               │
└──────────────────────────────────────────────────────┘
```

## 核心设计决策

| 维度 | 决策 |
|------|------|
| 记忆服务选型 | **Hindsight**（MIT 开源），LongMemEval 准确率 90%+，支持 biomimetic 数据结构 |
| 集成方式 | **OpenCode 插件路径**（`@konghayao/opencode-hindsight`），通过插件自动管理记忆读写 |
| MCP 路径 | **已废弃**——hindsight MCP server 不再创建，统一走 OpenCode 插件 |
| 自动记忆触发 | 委托 `@vectorize-io/opencode-hindsight` 插件，每次提问前 autoRecall、每 N 轮 autoRetain |
| Bank 隔离策略 | **用户级隔离**——每个用户（member ID）对应独立 Hindsight Bank |
| 数据存储 | 全部在 **Hindsight 外部服务**，RCS 只做反向代理，不存储记忆数据 |
| 前端渲染 | 记忆工具以**紫色 Brain 卡片**独立渲染，与普通工具调用视觉区分 |
| 记忆管理 UI | `/agent/memories` 页面，支持图谱/星座图/表格/时间线四种视图 |
| 部署方式 | Docker 部署，PostgreSQL 持久化，与 RCS 同 docker-compose |

## 设计原则：不重复造轮子

整个记忆集成的核心原则：**充分利用 Hindsight 原生能力，RCS 只做配置注入和 API 反向代理**。

- RCS **不存储记忆数据**——全部由 Hindsight 管理
- RCS **不实现记忆算法**——recall/retain/reflect 逻辑由 Hindsight 和 OpenCode 插件提供
- RCS **不管理记忆策略**——策略配置透传给 OpenCode 插件
- RCS 只负责**配置注入**（`hindsightApiUrl` + `bankId`）和**API 反向代理**（前端管理页面）

## 数据模型

### 无专用记忆表

`src/db/schema.ts` 中**没有** memory 专用表。记忆数据完全由外部 Hindsight 服务存储。

与记忆相关的间接依赖：
- `member` 表：用户 member ID 用作 Hindsight Bank ID
- `agentConfig.extra.plugin`：OpenCode agent 的插件配置，包含 Hindsight 插件参数

### Bank 隔离模型

```
RCS Organization ──1:N──▶ RCS User ──1:1──▶ RCS Member ──1:1──▶ Hindsight Bank
                                                                      │
                                                                      ├── memories (世界/经验/观察)
                                                                      ├── documents
                                                                      ├── mental_models
                                                                      └── entities
```

## 生命周期

### 1. 管理员启用 Hindsight

- 部署 Hindsight Docker 服务
- 设置 `HINDSIGHT_MCP_URL` 环境变量
- 前端 Agent 配置页检测到 Hindsight 可用时，显示记忆开关

### 2. Agent 启用记忆

管理员在 AgentConfig 中勾选"启用记忆"：
1. 幂等创建 Hindsight Bank（`PUT /v1/default/banks/{memberId}`）
2. OpenCode Agent 注入插件配置：`hindsightApiUrl` + `bankId`（`src/services/launch-spec-builder.ts:488-522`）

### 3. Agent 运行时 — 自动记忆（OpenCode 路径）

```
用户提问
    │
    ▼
OpenCode 插件: autoRecall ──▶ POST /v1/.../banks/{id}/memories/recall
    │                              │
    │                         召回相关记忆
    │                              │
    ▼                              ▼
将记忆注入到 prompt 末尾 ←── 返回 memories[]
    │
    ▼
LLM 处理 + 回复
    │
    ▼
OpenCode 插件: autoRetain (每 N 轮) ──▶ POST /v1/.../banks/{id}/memories
    │                                       │
    ▼                                  保存对话记录
Hindsight 自动 reflect/consolidate ◄──┘
```

**关键配置**（`web/src/pages/agent-panel/AgentFormDialog.tsx:118-128`）：

```typescript
const HINDSIGHT_DEFAULT_CONFIG = {
  autoRecall: true,           // 每次提问前自动召回记忆
  autoRetain: true,           // 回复后自动保存对话
  recallBudget: "mid",        // 召回详略程度
  retainEveryNTurns: 3,      // 每 N 轮触发一次 retain
  recallTags: [],             // 召回标签过滤
  recallTagsMatch: "any",    // 标签匹配模式
};
```

### 4. 前端管理

`/agent/memories` 页面提供完整的记忆管理功能：

| Tab | 视图 | 说明 |
|-----|------|------|
| 世界事实 | 四模式（图谱/星座/表格/时间线） | `fact_type: "world"` |
| 经验 | 同上 | `fact_type: "experience"` |
| 观察 | 同上 | `fact_type: "observation"` |
| 心理模型 | 卡片网格 | Hindsight 自动整合生成 |
| 实体 | 列表 + 关系图谱 | 实体共现关系 |

## 架构分层

### 后端

| 文件 | 层 | 职责 |
|------|-----|------|
| `src/services/hindsight.ts` | Service | Bank 管理、MCP server 注册、API 转发 |
| `src/routes/web/hindsight.ts` | Route | 反向代理（19 个端点），透传到 Hindsight |
| `src/services/launch-spec-builder.ts` | Service | OpenCode 启动时注入 Hindsight 插件配置 |
| `src/schemas/hindsight.schema.ts` | Schema | `/web/hindsight/status` 响应类型 |
| `src/env.ts` | Config | `HINDSIGHT_MCP_URL` 环境变量 |

### 后端路由表（`/web/hindsight`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/status` | 检查 Hindsight 配置状态 |
| GET | `/graph` | 获取记忆图谱数据 |
| GET | `/bank-stats` | 获取记忆库统计信息 |
| GET | `/memories` | 查询记忆列表（转发到 `.../memories/list`） |
| GET | `/memories/:id` | 获取记忆详情 |
| DELETE | `/memories/:id` | 删除记忆 |
| POST | `/memories` | 创建/保留记忆（retain） |
| POST | `/recall` | 语义检索记忆 |
| POST | `/reflect` | 触发记忆反思/整合 |
| GET | `/documents` | 查询文档列表 |
| POST | `/documents` | 上传文档（multipart/form-data） |
| DELETE | `/documents/:id` | 删除文档 |
| GET | `/documents/:id/chunks` | 查询文档分块 |
| GET | `/mental-models` | 查询心智模型列表 |
| GET | `/mental-models/:id` | 获取心智模型详情 |
| DELETE | `/mental-models/:id` | 删除心智模型 |
| GET | `/entities` | 查询实体列表 |
| GET | `/entities/:id` | 获取实体详情 |
| GET | `/entities/graph` | 获取实体关系图谱 |

所有路由均为**反向代理**，将请求透传到外部 Hindsight 服务的 v1 API（`/v1/default/banks/{bankId}/...`）。

### 前端

| 文件 | 职责 |
|------|------|
| `web/src/api/hindsight.ts` | 前端 API 客户端，封装所有 fetch 调用 |
| `web/src/pages/hindsight/types.ts` | 18 个类型接口定义 |
| `web/src/pages/hindsight/MemoriesPage.tsx` | 主页面（5 个 Tab，检查 Hindsight 状态） |
| `web/src/pages/hindsight/components/DataView.tsx` | 核心数据视图（图谱/星座/表格/时间线） |
| `web/src/pages/hindsight/components/Graph2d.tsx` | Cytoscape.js 图谱可视化 |
| `web/src/pages/hindsight/components/Constellation.tsx` | Canvas 星座图可视化 |
| `web/src/pages/hindsight/components/MemoryDetailModal.tsx` | 记忆详情弹窗 |
| `web/src/pages/hindsight/components/MemoryDetailPanel.tsx` | 图谱节点详情侧面板 |
| `web/src/pages/hindsight/components/EntitiesView.tsx` | 实体列表 + 关系图谱 |
| `web/src/pages/hindsight/components/MentalModelsView.tsx` | 心理模型卡片网格 |
| `web/src/pages/hindsight/components/DocumentsView.tsx` | 文档管理（上传/删除/搜索） |
| `web/components/chat/HindsightToolCard.tsx` | 聊天中记忆工具紫色卡片 |
| `web/components/chat/ToolCallGroup.tsx` | 工具调用分组（hindsight 独立渲染） |
| `web/components/chat/tool-call-utils.ts` | `isHindsightTool()` 判断函数 |

### 运行库

| 文件 | 职责 |
|------|------|
| `side-project/hindsight-opencode/src/index.ts` | `@konghayao/opencode-hindsight` 兼容包装 |
| `packages/plugin-opencode/src/runtime/runtime-config.ts` | 将 Hindsight 从普通 MCP 列表剔除（插件处理） |

### 部署

| 文件 | 职责 |
|------|------|
| `docker/hindsight/docker-compose.yml` | Hindsight 独立部署配置 |
| `docker/prod/docker-compose.yml` | 生产环境 `HINDSIGHT_MCP_URL` 配置 + Hindsight 服务 |
| `docker/sandbox/Dockerfile` | Sandbox 镜像安装 `@konghayao/opencode-hindsight` |
| `Dockerfile` | 主镜像安装 `@konghayao/opencode-hindsight` |

## 记忆类型体系

Hindsight 支持三种记忆类型（`fact_type`）：

| 类型 | 中文 | 说明 | 视图 |
|------|------|------|------|
| `world` | 世界事实 | 通用知识、事实性信息 | 默认视图 |
| `experience` | 经验 | Agent 的操作经验 | 单独 Tab |
| `observation` | 观察 | 对当前上下文的观察 | 单独 Tab |

另外，Hindsight 自动整合记忆生成：
- **Mental Models（心理模型）**：跨记忆的抽象概念和模式
- **Entities（实体）**：记忆中出现的重要实体及其关系

## 内存隔离与安全

- **Bank 隔离**：每个 RCS 用户（按 `member.id`）对应独立的 Hindsight Bank，不同用户的记忆完全隔离
- **反向代理**：RCS 前端不直接访问 Hindsight，所有请求通过 `/web/hindsight` 代理，RCS 负责根据当前用户解析对应的 `bankId`
- **MCP Server 隔离**：Hindsight MCP server 的 URL 包含 member ID（`{hindsightUrl}/mcp/{memberId}`），Agent 进程只能访问自己 bank 的 MCP 端点

## 环境变量

| 变量名 | 用途 | 必填 |
|--------|------|------|
| `HINDSIGHT_MCP_URL` | Hindsight 服务地址（e.g. `http://hindsight:9999`） | 否 |

## 故事 #17：记忆读写自动化

见禅道需求 #17「记忆读写自动化（针对opencode）」，核心目标：

1. ✅ **自动读取**：每次提问时自动从 Hindsight 召回记忆 → OpenCode 插件 `autoRecall`
2. ✅ **自动保存**：每轮回复后自动上报对话 → OpenCode 插件 `autoRetain` + `retainEveryNTurns`
3. ⏳ **记忆策略配置 UI**：`recallBudget`、`retainEveryNTurns` 等高级选项的前端面板
4. ⏳ **手动添加/修改记忆**：前端记忆管理页面的新增/编辑功能
5. ⏳ **手动添加/修改记忆**：前端记忆管理页面的新增/编辑功能

## 边界与后续规划

**当前范围**：OpenCode 插件实现自动记忆读写 + 前端记忆管理可视化 + 用户级 Bank 隔离

**后续规划**：
- 高级记忆策略配置 UI（`recallBudget`、`retainEveryNTurns` 等）
- 手动添加/编辑记忆的前端功能
- 记忆质量评估与反馈
- 跨组织记忆共享（如组织公共知识记忆）

---

> 调研日期：2026-07-16 | 基于 Hindsight v0.2.7 + `@konghayao/opencode-hindsight@0.1.1`
