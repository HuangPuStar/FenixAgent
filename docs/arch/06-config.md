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
| Hindsight | [→ 记忆配置](./06-config-hindsight.md) | AI 长期记忆，启动参数注入插件，bank 隔离 |
| UserConfig | — | 用户偏好（默认 Agent、默认模型） |

## 跨组织共享

所有配置模块（Provider / Model / Skill / McpServer）支持公开可读；写入参数使用 `publicReadable`，响应中的归属与权限使用 `scope` / `access`。控制台已有资源一律按数据库 ID 定位，跨组织同名资源也不靠名称消歧。

## 控制台资源接口

`/web/config` 服务内部前端，前后端同步发布。集合 GET/POST 分别用于列表/创建，单资源 GET/PATCH/DELETE 用于详情/更新/删除；不存在的 ID 不能触发创建。ID 是非空资源标识，服务端生成 UUID；名称用于展示、创建与领域判重，不作为管理动作定位键。

| 资源 | 集合 | 单资源与附加动作 |
| --- | --- | --- |
| AgentConfig | `/agents` | `/agents/:id`；POST `/:id/restart` |
| Skill | `/skills` | `/skills/:id`；GET `/:id/download`；PATCH `/:id/access` |
| MCP | `/mcp` | `/mcp/:id`；PATCH 同路径启停；POST `/:id/test`、`/:id/inspect`；GET `/:id/tools` |
| Provider | `/providers` | `/providers/:providerId`；POST `/:providerId/fetch-models` |
| Model | POST `/providers/:providerId/models` | PATCH/DELETE `/providers/:providerId/models/:id`；POST 同路径加 `/test` |

以上路径均相对于 `/web/config`。Agent/MCP/Provider 集合拒绝旧 `name` 查询参数（422），不将其静默解释成列表；旧写路径直接移除。Skill 上传、Agent 模板、默认 Agent、默认模型偏好与 `/api/*` 的已发布契约保持原语义。

每次 ID 查询均由所属 Facade 下推授权条件；ID 不授予权限。Model 授权继承 Provider，子行更新、删除和探测均校验父子归属。内置 Agent 删除保护依据真实行名称判断。

Provider 的 `id` 是行 ID、`name` 是配置名、`displayName` 是展示名；Model 的 `id` 是行 ID、`modelId` 是上游代码。Provider 创建同组织同名时原子返回 409，不覆盖已有配置。已存 Provider 探测要求 update 权限；草稿使用 POST `/providers/probe-models`，仅使用显式输入，不读取已存密钥。MCP 草稿使用 POST `/mcp/test-url`。

本契约不调整名称唯一约束或增加改名能力，不需要数据迁移。发布与回滚应同时切换前后端版本。

