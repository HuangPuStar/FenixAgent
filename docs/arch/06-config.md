# 配置系统

> 涉及模块：Provider、Model、Skill、MCP Server、UserConfig、跨组织共享

## 概述

配置系统管理 Agent 运行所需的全部配置资源，存在 PostgreSQL 中，按组织隔离（多租户），支持跨组织共享。Agent 实例启动时自动注入。

## 配置模块

```
Provider（服务商）                  → 模型配置
  └── Model（模型）                 → 模型配置

Skill（技能）                       → Skills 配置

McpServer（MCP）                    → MCP 配置

Hindsight（记忆）                   → 记忆配置

UserConfig（用户偏好）               默认 Agent / 模型偏好
```

| 模块 | 详情 | 说明 |
|------|------|------|
| Provider & Model | [→ 模型配置](./06-config-provider.md) | AI 服务商 + 模型，apiKey 掩码，跨组织共享 |
| Skills | [→ Skills 配置](./06-config-skills.md) | DB + 文件系统双存储，spawn 时打包注入 |
| MCP Server | [→ MCP 配置](./06-config-mcp.md) | 外部工具服务，4 种类型，严格校验 |
| Hindsight | [→ 记忆配置](./06-config-hindsight.md) | AI 长期记忆，MCP 集成，bank 隔离 |
| UserConfig | — | 用户偏好（默认 Agent、默认模型） |

## 跨组织共享

所有配置模块（Provider / Model / Skill / McpServer）支持 `publicReadable` 公开可读。跨组织引用通过 resourceKey（`来源组织ID/资源UUID`）标识，路由层自动解析。

