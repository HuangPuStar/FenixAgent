# 知识库

## 这个模块干什么

知识库系统让用户可以给 AI Agent 补充专属知识——上传文档、代码、网页等，系统自动建立索引，Agent 在运行时可以通过 MCP 端点查询这些知识。

简单说就是：**帮 Agent 建立"自己的资料库"**。

## 架构

```text
用户（前端）
    │
    │  CRUD 知识库、上传文件
    ▼
┌─────────────────────────────────────────┐
│  知识库元数据 CRUD                       │
│  文件上传处理                             │
│  运行时状态管理                           │
│  Agent↔知识库绑定                        │
├─────────────────────────────────────────┤
│  KnowledgeProvider 抽象层                │
│    ├── Provider 接口定义                 │
│    └── RagFlow 实现                     │
└──────────┬──────────────────────────────┘
           │
           ▼
    外部知识库服务（RagFlow）
    做向量索引和检索

Agent 运行时
    │
    │  MCP 查询
    ▼
  MCP 知识库端点 → 运行时模块 → Provider
```

## 组件分工

### KnowledgeBase（知识库管理）

知识库的 CRUD 管理。每个知识库按 organizationId 隔离，核心字段：

- `name` / `slug`：名称和 URL 标识
- `provider`：后端提供者（目前默认 ragflow）
- `remoteId`：在远程 Provider 那边的资源 ID
- `remoteAccountId` / `remoteUserId`：RagFlow 的账户绑定信息
- `description`：知识库描述
- `status`：empty / indexing / ready / error
- `lastError`：最近一次错误信息

创建知识库时，同步在远程 Provider 那边也创建一个对应的索引。删除时同步删除远程资源。

### KnowledgeUpload（文件上传）

处理文件上传。把用户上传的文件提交给 KnowledgeProvider 建索引。在 `knowledge_resource` 表中跟踪每个资源的状态（pending → processing → ready / error），记录字段包括来源类型（文件/URL）、来源名称、来源路径、远程资源 ID、最近错误。

提供远端资源状态轮询、从 URL 导入资源、根据关联资源汇总更新知识库状态等功能。

### KnowledgeRuntime（运行时查询）

知识库运行时——当 Agent 查询知识库时，这个模块负责把查询转发给 Provider，拿到结果返回。

### AgentKnowledge（绑定管理）

管理"哪个 Agent 用哪些知识库"的绑定关系。存在 `agent_knowledge_binding` 表中，支持优先级排序。

当 Instance spawn 时，会检查绑定关系，把知识库的 MCP 端点注入到 workspace 的运行时配置中。

### KnowledgeProvider（外部索引抽象）

Provider 是对外部索引服务的抽象。定义了统一的接口（创建知识库、添加资源、列出资源、读取资源、删除资源、搜索），目前实现了 RagFlow。新增索引服务只需实现该接口。

### MCP 端点（Agent 查询入口）

Agent 运行时通过 MCP 端点查询知识库。它在 Agent 的 workspace 配置中作为 remote MCP server 注册——RCS 作为 MCP server，提供知识库查询能力供 Agent 调用。认证通过 Bearer token 完成。

## 数据库表

| 表 | 说明 |
|----|------|
| `knowledge_base` | 知识库元数据（name、slug、status、remoteId） |
| `knowledge_resource` | 上传的文件资源（关联 knowledge_base，状态跟踪） |
| `agent_knowledge_binding` | Agent↔知识库绑定（多对多，带优先级） |

## 和其他模块的关系

- → **数据库 Schema**：操作 knowledge 系列表
- → **KnowledgeProvider**：远程索引服务调用（RagFlow）
- → **配置服务**：读取 Provider 配置
- ← **Instance 服务**：spawn 时注入 MCP 知识库端点
- ← **前端路由**：知识库 CRUD API
- ← **MCP 路由**：Agent 运行时查询端点
