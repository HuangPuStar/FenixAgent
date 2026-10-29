# @fenix/resource-channel

IM 消息通道能力的 owner：LangBot 控制面、Webhook 入站、`/mcp/im` 与 `im_*` 持久化。设计与契约见
`docs/arch/30-langbot-channel-gateway.md`（以 main 为准；本包实现紧随该文档）。

## 交付物

- **表定义** `@fenix/resource-channel/db`（`db/schema.ts`）：`im_channel`、`im_channel_route`、
  `im_channel_conversation`、`im_channel_event`；DDL 与迁移链一致（`bun run check:schema-ddl-drift`）。
- **模块描述符** `@fenix/resource-channel/module`（`fenix.module.ts`）：`id: "channel"` /
  `kind: "resource"` / `dependsOn: []` / `capabilities: ["resource.channel"]`。声明 `create`、四项
  `envDefinitions`（`LANGBOT_BASE_URL` / `LANGBOT_API_KEY` / `IM_TOKEN_SECRET` /
  `IM_EVENT_TEXT_TTL_HOURS`）、四条路由贡献与浏览器面 `web.contribution`。
- **服务端入口** `@fenix/resource-channel/server`：Facade、模块装配、宿主端口与路由工厂。
- **浏览器入口** `@fenix/resource-channel/web` 与 `@fenix/resource-channel/web/contribution`：
  `/agent/channels`、`/admin/channels` 页面、API client 与 i18n。
- **根入口** `@fenix/resource-channel` 刻意为空，避免消费方绕过面边界。

## 协议面

| 路径 | 认证 | 用途 |
| --- | --- | --- |
| `/web/channels/langbot/*` | 会话 + 组织上下文 | Bot / 路由 / 会话控制面与探测 |
| `/hooks/langbot/:channelId` | 无会话（`channelId` 路径凭据） | LangBot 事件入站 |
| `/mcp/im` | `Authorization: Bearer <IM_TOKEN>` | Agent 的 `im://inbox`、`im_reply`、`im_context` 与 Skill |
| `/api/system/channels/*` | 系统管理密钥 | 跨组织通道拓扑与会话诊断 |

## 分层

- `src/server/repositories/`：四张表的持久化原语（去重写入、待读分页、状态迁移、保留策略），只在包内使用。
- `src/server/services/langbot/`：Service API 客户端、通道 / 路由 / 会话服务、入站解析与去重、
  `send_message` 出站、进程内订阅通知分发、事件维护与连接 token 签发。
- `src/server/services/im-mcp/`：`/mcp/im` 的 inbox 资源、回复与上下文工具、Skill 下发。
- `src/server/routes/`：只做协议接入；授权、租户边界与 LangBot 调用在 Facade。
- `web/`：通道页面、admin 页面、API client 与 i18n，经 `web/contribution.ts` 挂到 Shell。

## 表与外键

- `im_channel.user_id → user.id`（级联）。
- `im_channel_route` / `im_channel_conversation` 的 `agent_config_id → agent_config.id`（级联）；
  `im_channel_event.agent_config_id → agent_config.id`（`set null`，保留审计行）。
- 这些外键在 `db/schema.ts` **组装期**导入 `@fenix/identity/db` 与 `@fenix/agent-config/db` 的列对象
  （§6.1 例外，不进 `dependsOn`）；`src/**` 运行期不导入这两个包。

## 约束

- **Webhook 暴露面**：LangBot Webhook 没有签名机制，安全依赖「仅容器网络可达 + `channelId` 不可枚举」；
  公网暴露必须在前置网关上做来源限制。
- **投递只保证进程内**：服务重启时把遗留的 `received` / `delivered` 标记 `failed`（`reason=restart`），
  不重放；启用 IM 时主服务按单实例部署，不做跨进程通知扇出。
- **租户与权限**：组织取自 `actor.activeOrganizationId`，跨组织资源一律 404；变更操作限通道创建者或组织
  管理员，读取组织内可见；Agent 绑定校验的是通道所有者的 `use` 权限。
- **Agent 配置可见性**经宿主注入的 `ChannelAgentConfigLookup` 端口判断，不在本包值导入 agent-config。
