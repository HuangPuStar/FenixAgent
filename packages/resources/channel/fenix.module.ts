import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { z } from "zod/v4";

/**
 * Channel 资源模块描述符。
 *
 * 本包持有 IM 通道的持久化定义（出口 `@fenix/resource-channel/db`）、LangBot 控制面与数据面服务层、
 * `/web/channels/langbot`（控制面）、`/hooks/langbot/:channelId`（数据面入站）、`/mcp/im`（Agent
 * 工具与订阅）与 `/api/system/channels`（系统管理面）路由（出口 `@fenix/resource-channel/server`），
 * 以及通道页面、admin 页面与 i18n（出口 `@fenix/resource-channel/web`）。
 *
 * `dependsOn: []`：本包是叶子模块，装配上不要求任何其它资源模块同批启用。跨包外键的列对象只在
 * `db/schema.ts` 的组装期导入（§6.1 例外），不构成装配边；`agent_config` 的可见性判定经宿主注入的
 * `ChannelAgentConfigLookup` 端口完成，不在 `src/**` 里值导入 agent-config。
 *
 * LangBot 三项配置**刻意声明在模块侧**而不是宿主 `apps/server/src/env.ts`：它们只有本模块消费，宿主
 * 只做投影（`bootstrap/module-configs.ts`）。三者都允许缺省：未配置 `LANGBOT_BASE_URL` 的部署不启用数据面，
 * 只让控制面端点返回 503，不影响服务启动；一旦配置了基址，数据面密钥的完整性由装配期校验兜住
 * （`src/module.ts`），缺失即启动失败。
 */
export const moduleManifest = {
  id: "channel",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.channel"],
  envDefinitions: [
    {
      moduleId: "channel",
      key: "LANGBOT_BASE_URL",
      // 形状（http/https、路径前缀）由包内 `config.ts` 在调用期校验：这里放宽到字符串，避免配错一个
      // 尚未启用的端点就让整个服务无法启动。
      schema: z.string().optional(),
      secret: false,
      restartRequired: true,
      description:
        "LangBot Service API 基址（例如 http://langbot:5300/api/v1）。未配置时控制面返回 LANGBOT_NOT_CONFIGURED；/healthz 从同源根路径探测。",
    },
    {
      moduleId: "channel",
      key: "LANGBOT_API_KEY",
      schema: z.string().optional(),
      secret: true,
      restartRequired: true,
      description:
        "LangBot Service API 的实例级共享密钥（X-API-Key）；配置 LANGBOT_BASE_URL 时必需，缺失即启动失败。只在服务端使用：不落库、不回显、不进入日志与错误文案。",
    },
    {
      moduleId: "channel",
      key: "IM_TOKEN_SECRET",
      schema: z.string().optional(),
      secret: true,
      restartRequired: true,
      description:
        "IM 连接 token 的 HMAC 密钥；配置 LANGBOT_BASE_URL 时必需（数据面每条消息都依赖它），缺失即启动失败，未启用 LangBot 的部署可留空。",
    },
    {
      moduleId: "channel",
      key: "IM_EVENT_TEXT_TTL_HOURS",
      schema: z.coerce.number().int().positive().default(24),
      defaultValue: 24,
      secret: false,
      restartRequired: true,
      description:
        "入站事件正文的保留小时数。数据面启用时按它清理 im_channel_event.text；控制面只校验形状，不消费该值。",
    },
  ],
  web: {
    id: "channel",
    contribution: "@fenix/resource-channel/web/contribution",
  },
  contributions: [
    {
      id: "channel.web-langbot",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createChannelLangBotWebRoutes(host)),
    },
    {
      id: "channel.hooks-langbot",
      kind: "app-route",
      slot: "app",
      // 工厂不消费 host：Webhook 无会话认证，channelId 即路径凭据（规格 §4.3）。
      value: () => import("./src/server/assembly").then((assembly) => assembly.createChannelLangBotHookRoutes()),
    },
    {
      id: "channel.mcp-im",
      kind: "app-route",
      slot: "app",
      // 同样不消费 host：连接 token 是唯一凭据，不能复用会话守卫（规格 §4.4 / §9.7）。
      value: () => import("./src/server/assembly").then((assembly) => assembly.createChannelImMcpRoutes()),
    },
    {
      id: "channel.api-system-channels",
      kind: "app-route",
      slot: "api",
      // 系统管理面（`/api/system/channels`）：admin 页面用 master key 认证，没有组织上下文，控制面的
      // `/web/channels/langbot/*` 带组织过滤，两者不能共用一条路由。惰性构造同 `channel.web-langbot`：
      // registry 会被大量位置导入，不能在索引层就把 Elysia 拖进模块图。
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createChannelApiSystemRoutes(host)),
    },
  ],
  create: (context) => import("./src/module").then((module) => module.createChannelModule(context)),
} satisfies ModuleManifest;
