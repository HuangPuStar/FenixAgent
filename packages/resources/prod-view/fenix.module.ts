import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";

/**
 * ProdView（发布视图）资源模块描述符。
 *
 * 「Agent 配置 + 一组 Chat 模块开关 → 可对外分享的只读视图」这一能力的唯一 owner：领域规则、持久化
 * 与 HTTP 交付物都在本包服务端——`/web/config/prod-views` 的管理 CRUD，以及 `/web/prod-views/:id/load`
 * （把视图解析为 `agentConfigId + environmentId + instanceUid + modulesConfig`，浏览器据此连到该用户的
 * 持久实例；只解析实例身份，不预启动 runtime）。两个路由都以工厂导出
 * （`createWebProdViewsRoutes` / `createWebConfigProdViewsRoutes`），守卫由宿主注入。
 *
 * 声明 `contributions`（1.5e 试点）：两条路由各自把「构造路由实例」表达为惰性构造函数
 * `(host) => import("./src/server/assembly").then(...)`，`slot` 指明挂宿主的哪一个协议聚合面——路由
 * 路径保持相对形式（本包不写 `/web` 前缀），前缀由宿主的聚合实例决定，因此「挂哪一面」只能由声明说清。
 * 惰性 import 与 `create` 同因：registry 会被大量位置导入，不能在索引层就把 Elysia 与 Drizzle 拖进
 * 模块图。`order` 不声明（默认 0）：本包两条路由都不是兜底或通配，顺序由宿主序列决定。
 *
 * `dependsOn: []`（叶子模块）。按代码实测，本包服务端生产代码没有任何指向已注册**资源**模块的值导入
 * （生成器的扫描范围是 `src/**`，`web/**` 不参与服务端装配顺序）：
 *
 * - 唯一需要参与装配依赖判定的跨包值导入是 `src/server/services/prod-view.ts` 的
 *   `@fenix/agent-runtime/runtime`（取运行 port 后调 `createEnvironment` 建视图专用 environment、
 *   `findOrCreateDefaultInstance` 解析该用户的持久实例）。agent-runtime 是
 *   `agent-runtime` 类别的基础模块，在 profile 里是固定槽位（`requireFoundation` 总是启用），不进入
 *   资源模块的装配依赖校验范围；该跨类别边由 §2.3 依赖矩阵与架构台账负责（owner 1.4）。
 * - 另有 3 处 `@fenix/platform-sdk` 值导入（`src/server/db.ts` 的 `getDatabase`，两个路由文件的
 *   `WebErrSchema`）；platform-sdk 是契约包，没有模块 ID 可声明，同样不进 `dependsOn`。
 * - 表定义仍取自宿主 `@server/db/schema`（`prod_view`，迁出归 §1.7，台账条目 `apps-boundary` 的 owner
 *   已改为 1.7）：这是 §5 明确保留的残留，不是可编码的装配依赖。
 * - web 侧的跨包耦合只有一条，且不进服务端装配：`@fenix/agent-config/web`
 *   （`web/pages/agent-panel/**` 的 `agentApi`，取 agent 名称做创建时的默认值）。web 贡献的启用由
 *   profile 的 `web` 列表表达（§1.6）。原先的第二条——`web/pages/prod-view/ProdViewPage.tsx`
 *   对 `@fenix/chat-channel/web/chat-area` 的 lazy import——已由 CE 阶段 2 任务 1.6 T5b 消除：
 *   聊天容器改由宿主经 `chatArea` prop 注入（`ProdViewChatAreaProps`），本包不再依赖聊天包。
 *
 * `create`：模块组合根 `src/module.ts` 的 `createProdViewModule()`，返回包内既有单例（`prodViewRepo`
 * 是 `prod_view` 表的唯一数据访问点）。registry 驱动的装配（§1.5 的 `mountContribution`）需要统一拿到
 * 模块实例，故在 W2 落地；路由工厂与领域服务都是宿主显式调用的无状态入口，不经模块实例转发。
 * 不声明 `web` / `envDefinitions`：`web` 的消费方是 §1.6 的 WebShell 装配，形状必须与消费端同时定型；
 * `envDefinitions` 的宿主登记归 §1.7（本包不读 `process.env`）。
 */
export const moduleManifest = {
  id: "prod-view",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.prod-view"],
  contributions: [
    {
      id: "prod-view.web",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createProdViewWebRoutes(host)),
    },
    {
      id: "prod-view.web-config",
      kind: "app-route",
      slot: "web-config",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createProdViewWebConfigRoutes(host)),
    },
  ],
  create: () => import("./src/module").then((module) => module.createProdViewModule()),
} satisfies ModuleManifest;
