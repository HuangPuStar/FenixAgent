# MCP 工具集成

MCP（Model Context Protocol）是 LLM 调用外部 API 的标准协议。通过 MCP，Agent 可以连接数据库、搜索引擎、GitHub、文件系统等外部服务，获得远超纯文本生成的能力。

## MCP 概念

MCP 定义了一套标准化的工具调用协议：

```
Agent → MCP Client → MCP Server（外部工具）→ 返回结果 → Agent
```

每个 MCP Server 提供一组**工具（Tools）**，每个工具有明确的名称、描述和参数 Schema。Agent 在推理时看到这些工具的描述，根据需要调用它们。

例如，接入 GitHub MCP Server 后，Agent 就能创建 Issue、查看 PR、搜索代码——这些不是 Agent 内置的能力，而是通过 MCP 获得的。

## 推荐架构：Streamable HTTP

FenixAgent 支持三种 MCP 传输类型：

| 类型 | 传输方式 | 适用场景 |
|------|---------|---------|
| `streamable-http` | HTTP 长连接 | **推荐** — MCP Server 独立部署为服务，Agent 远程调用 |
| `remote` | HTTP/SSE | 连接第三方托管的 MCP 服务 |
| `local` | stdio（本地进程） | 快速实验、本地开发调试 |

**我们推荐使用 `streamable-http`**，将 MCP Server 部署为独立运行的 HTTP 服务。这种架构有显著优势：

### 为什么推荐分离部署

**1. 稳定性**

Local MCP 的 Server 进程和 Agent 运行在同一台机器上，Agent 崩溃或重启会连带影响 MCP Server。分离部署后，MCP Server 是独立进程，Agent 的生命周期与工具服务完全解耦。

**2. 可扩展性**

MCP Server 可以独立扩容。当多个 Agent 同时调用同一个工具时，HTTP 服务可以水平扩展、做负载均衡，而本地进程只能单点运行。

**3. 复用性**

同一个 MCP Server 可以被多个 FenixAgent 实例、多个 Team 共享。不同项目的 Agent 连接同一个工具服务，避免重复部署。

**4. 安全隔离**

MCP Server 和 Agent 运行在不同的进程/机器上，可以通过网络策略控制访问权限。API Key、数据库凭证等敏感信息只存在于 MCP Server 侧，FenixAgent 侧无需持有。

```
┌─────────────────┐         ┌─────────────────────┐
│   RCS + Agent   │  HTTP   │   MCP Server 集群    │
│                 │ ──────► │                     │
│  opencode 运行时 │         │  ├── GitHub Tools   │
│                 │         │  ├── DB Query       │
└─────────────────┘         │  └── Search Engine  │
                            └─────────────────────┘
```

## 接入 MCP Server

在 FenixAgent 控制台的 MCP 页面添加 MCP Server。根据类型填写连接信息：

- **Streamable HTTP** — 填写 MCP Server 的 HTTP 端点 URL、认证 headers（如 Bearer Token）、超时时间。支持 OAuth 认证
- **Remote** — 填写第三方 MCP 服务端点 URL 和认证信息
- **Local** — 填写启动命令（如 `npx -y @modelcontextprotocol/server-github`）和环境变量

API Key 等敏感信息使用 `{env:SECRET_NAME}` 格式引用环境变量，不要直接写明文。

## 工具发现

添加 MCP Server 后，FenixAgent 会自动检测它提供的工具列表：

1. 连接 MCP Server
2. 调用 `tools/list` 接口获取工具清单
3. 缓存工具名称、描述和参数 Schema 到数据库
4. Agent 启动时，这些工具描述会被注入到 Agent 的上下文中

在 FenixAgent 控制台的 MCP 页面，你可以查看每个 MCP Server 提供的工具详情，包括参数格式和使用说明。

## 自定义 MCP Server

如果现有的 MCP Server 不能满足需求，你可以开发自己的，然后部署为 streamable-http 服务。

### MCP Server 开发要点

MCP Server 需要实现以下接口：

- `tools/list` — 返回可用工具列表，每个工具包含 name、description、inputSchema
- `tools/call` — 接收工具调用请求，执行操作，返回结果

可以用 Python（`mcp` 包的 FastMCP）或 TypeScript（`@modelcontextprotocol/sdk`）开发，然后部署为 HTTP 服务。也可以用 Docker 容器化部署，方便管理和扩展。

部署完成后，在 FenixAgent 控制台添加 streamable-http 类型的 MCP 配置即可接入。

## 常见 MCP Server

| 工具 | 类型 | 说明 |
|------|------|------|
| GitHub | local / streamable-http | Issue、PR、代码搜索 |
| 文件系统 | local | 受限的文件读写 |
| PostgreSQL | local / streamable-http | 数据库查询 |
| Brave Search | local | 网络搜索 |

## 最佳实践

### 工具设计

- **单一职责** — 每个工具只做一件事。`search_users` 和 `create_user` 分开，不要合并成 `manage_users`
- **清晰的描述** — 工具描述是 Agent 决定是否调用的依据。写清楚"这个工具做什么"和"什么时候该用"
- **结构化参数** — 使用 JSON Schema 定义输入参数，包含类型、描述和枚举值
- **错误信息有用** — 工具出错时返回可理解的错误信息，方便 Agent 自行调整重试

### 部署架构

- **优先 streamable-http** — 生产环境始终使用 streamable-http 分离部署
- **一个服务一个职责** — 数据库查询、GitHub 操作、搜索引擎分别部署为独立的 MCP Server
- **网关统一入口** — 如果有多个 MCP Server，可以用 API 网关统一暴露，FenixAgent 只需配置一个入口 URL
- **健康检查** — MCP Server 提供健康检查端点，配合监控确保可用性

### 安全考虑

- 敏感操作的工具设为需要确认（通过 Permission 控制）
- 数据库查询工具限制为只读
- API Key 通过环境变量注入，不硬编码
- streamable-http 服务部署在内网，通过网关暴露给 FenixAgent
- 设置合理的超时时间

## 下一步

- [知识库](./knowledge-base) — FenixAgent 内置的知识库也是一个通过 MCP 提供的工具
