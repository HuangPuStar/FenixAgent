# 知识库

> 对应文件：`src/services/knowledge-base.ts`、`src/services/knowledge-runtime.ts`、`src/services/knowledge-upload.ts`、`src/services/knowledge-provider/`、`src/services/agent-knowledge.ts`、`src/routes/mcp/knowledge.ts`

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
│  knowledge-base.ts    知识库元数据 CRUD  │
│  knowledge-upload.ts  文件上传处理       │
│  knowledge-runtime.ts 运行时状态管理     │
│  agent-knowledge.ts   Agent↔知识库绑定  │
├─────────────────────────────────────────┤
│  knowledge-provider/                     │
│    ├── types.ts       Provider 接口定义  │
│    └── ragflow.ts     RagFlow 实现       │
└──────────┬──────────────────────────────┘
           │
           ▼
    外部知识库服务（RagFlow）
    做向量索引和检索

Agent 运行时
    │
    │  MCP /mcp/knowledge 查询
    ▼
  routes/mcp/knowledge.ts → knowledge-runtime.ts → Provider
```

## 组件分工

### KnowledgeBase（`knowledge-base.ts`）

知识库的 CRUD 管理。每个知识库按 organizationId 隔离，核心字段：

- `name` / `slug`：名称和 URL 标识
- `provider`：后端提供者（目前默认 ragflow）
- `remoteId`：在远程 Provider 那边的资源 ID
- `remoteAccountId` / `remoteUserId`：RagFlow 的账户绑定信息
- `description`：知识库描述
- `status`：empty / indexing / ready / error
- `lastError`：最近一次错误信息

创建知识库时，同步在远程 Provider 那边也创建一个对应的索引。删除时同步删除远程资源。

### KnowledgeUpload（`knowledge-upload.ts`）

处理文件上传。把用户上传的文件提交给 KnowledgeProvider 建索引。在 `knowledge_resource` 表中跟踪每个资源的状态（pending → processing → ready / error），记录字段包括 `sourceType`（文件/URL 来源类型）、`sourceName`、`sourcePath`、`remoteId`、`lastError`。

提供 `refreshKnowledgeResourceStatus()` 轮询远端资源解析状态、`importKnowledgeResourceFromUrl()` 从 URL 导入资源、`upsertKnowledgeBaseStatusFromResources()` 根据关联资源汇总更新知识库状态。

### KnowledgeRuntime（`knowledge-runtime.ts`）

知识库运行时——当 Agent 查询知识库时，这个模块负责把查询转发给 Provider，拿到结果返回。

### AgentKnowledge（`agent-knowledge.ts`）

管理"哪个 Agent 用哪些知识库"的绑定关系。存在 `agent_knowledge_binding` 表中，支持优先级排序。

当 instance spawn 时（`instance.ts`），会检查绑定关系，把知识库的 MCP 端点注入到 workspace 的 `.opencode/opencode.json` 配置中。

### KnowledgeProvider（`knowledge-provider/`）

Provider 是对外部索引服务的抽象。目前只实现了 RagFlow：

- `types.ts`：定义 `KnowledgeProvider` 接口（createKnowledgeBase、addResource、listResources、readResource、deleteResource、search）
- `ragflow.ts`：RagFlow 的 HTTP API 实现

Provider 的配置来自 `config.ts`：
- `RAGFLOW_API_URL`：Provider 的 HTTP 地址
- `RAGFLOW_API_KEY`：认证 key
- `RAGFLOW_REQUEST_TIMEOUT_MS`：请求超时

### MCP 端点（`routes/mcp/knowledge.ts`）

Agent 运行时通过这个 MCP 端点查询知识库。它在 Agent 的 workspace 配置中作为 remote MCP server 注册：

```json
{
  "mcp": {
    "kb": {
      "type": "remote",
      "url": "http://rcs-host/mcp/knowledge",
      "headers": { "Authorization": "Bearer {env.secret}" }
    }
  }
}
```

## 数据库表

| 表 | 说明 |
|----|------|
| `knowledge_base` | 知识库元数据（name、slug、status、remoteId） |
| `knowledge_resource` | 上传的文件资源（关联 knowledge_base，状态跟踪） |
| `agent_knowledge_binding` | Agent↔知识库绑定（多对多，带优先级） |

## 和其他模块的关系

- → `db/schema.ts`：操作 knowledge 系列表
- → `knowledge-provider/ragflow.ts`：远程索引服务调用
- → `config.ts`：读取 Provider 配置
- ← `services/instance.ts`：spawn 时注入 MCP 知识库端点
- ← `routes/web/knowledge-bases.ts`：前端 CRUD API
- ← `routes/mcp/knowledge.ts`：Agent 运行时查询
