# MCP 配置

> 涉及模块：MCP Server 配置服务、MCP Tool 缓存、LaunchSpec Builder

## 概述

MCP Server 是 Agent 可调用的外部工具服务。AgentConfig 通过多对多绑定挂载 MCP，spawn 时注入到 Agent 运行时。

```mermaid
flowchart LR
    AC[Agent Config] -->|agentConfigMcp 绑定| MCP[McpServer]
    MCP -->|"spawn 校验"| CHK{配置合法?}
    CHK -->|"通过"| SPEC[McpServerConfig]
    CHK -->|"禁用/缺失/非法"| ERR["拒绝启动"]
    SPEC -->|"注入"| LS[AgentLaunchSpec]

## 四种类型

| 类型 | 说明 | 核心字段 |
|------|------|----------|
| `local` | 命令行启动（stdio transport） | `command`、`args`、`env`、`timeout` |
| `remote` | URL 连接（SSE transport） | `url`、`headers`、`oauth` |
| `streamable-http` | Streamable HTTP 连接 | `url`、`headers`、`timeout` |
| `disabled` | 已禁用的服务器 | 仅 `enabled: false`，config 为空 |

## Tool 缓存

`mcpTool` 缓存表存储每个 MCP server 提供的工具列表。每次检查时在事务内原子替换（先删后插），避免并发读写不一致。缓存包含检查时间戳，支持按需刷新。

## 与 AgentConfig 的关系

AgentConfig 通过 `agentConfigMcp` 多对多表绑定 MCP。更新时全量覆盖。spawn 时 LaunchSpec Builder 进行严格校验：

- 禁用或缺失的 MCP 直接拒绝启动（不跳过）
- 配置格式非法（如空 command/url）也拒绝启动
- 通过校验后才翻译为 `McpServerConfig` 注入 `AgentLaunchSpec`

详见 [Agent Config 资源引用](./04-agent-config.md)。

## 跨组织共享

McpServer 支持 `publicReadable` 公开可读。跨组织引用时通过 resourceKey 标识。
