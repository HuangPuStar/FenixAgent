import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * ProdView（发布视图）资源模块描述符。
 *
 * 「Agent 配置 + 一组 Chat 模块开关 → 可对外分享的只读视图」这一能力的唯一 owner：领域规则、持久化
 * 与 HTTP 交付物都在本包服务端——`/web/config/prod-views` 的管理 CRUD，以及 `/web/prod-views/:id/load`
 * （把视图解析为 `agentConfigId + environmentId + instanceUid + modulesConfig`，浏览器据此连到该用户的
 * 持久实例；只解析实例身份，不预启动 runtime）。两个路由都以工厂导出
 * （`createWebProdViewsRoutes` / `createWebConfigProdViewsRoutes`），守卫由宿主注入；宿主
 * `apps/server/src/routes/web/index.ts` 与 `routes/web/config/index.ts` 各自 `.use()` 工厂的返回值。
 *
 * `dependsOn: []`（叶子模块）。按代码实测，本包服务端生产代码没有任何指向已注册**资源**模块的值导入
 * （生成器的扫描范围是 `src/**`，`web/**` 不参与服务端装配顺序）：
 *
 * - 唯一需要参与装配依赖判定的跨包值导入是 `src/server/services/prod-view.ts` 的
 *   `@fenix/agent-runtime/server`（`createWebEnvironment` 建视图专用 environment，
 *   `agentInstanceService.findOrCreateDefaultInstance` 解析该用户的持久实例）。agent-runtime 是
 *   `agent-runtime` 类别的基础模块，在 profile 里是固定槽位（`requireFoundation` 总是启用），不进入
 *   资源模块的装配依赖校验范围；该跨类别边由 §2.3 依赖矩阵与架构台账负责（owner 1.4）。
 * - 另有 3 处 `@fenix/platform-sdk` 值导入（`src/server/db.ts` 的 `getDatabase`，两个路由文件的
 *   `WebErrSchema`）；platform-sdk 是契约包，没有模块 ID 可声明，同样不进 `dependsOn`。
 * - 表定义仍取自宿主 `@server/db/schema`（`prod_view`，迁出归 §1.7，台账条目 `apps-boundary` 的 owner
 *   已改为 1.7）：这是 §5 明确保留的残留，不是可编码的装配依赖。
 * - web 侧的两条耦合都不进服务端装配：`@fenix/chat-channel/web/chat-area`
 *   （`web/pages/prod-view/ProdViewPage.tsx` 的 lazy import）与 `@fenix/agent-config/web`
 *   （`web/pages/agent-panel/**` 的 `agentApi`，取 agent 名称做创建时的默认值）。web 贡献的启用由
 *   profile 的 `web` 列表表达（§1.6），且 chat-channel 尚无 manifest、没有模块 ID 可声明。
 *
 * `create`：模块组合根 `src/module.ts` 的 `createProdViewModule()`，返回包内既有单例（`prodViewRepo`
 * 是 `prod_view` 表的唯一数据访问点）。registry 驱动的装配（§1.5 的 `mountContribution`）需要统一拿到
 * 模块实例，故在 W2 落地；路由工厂与领域服务都是宿主显式调用的无状态入口，不经模块实例转发。
 * 不声明 `contributions` / `web` / `envDefinitions`：前两者的消费方分别是 §1.5 的宿主挂载与 §1.6 的
 * WebShell 装配，形状必须与消费端同时定型；`envDefinitions` 的宿主登记归 §1.7（本包不读 `process.env`）。
 */
export const moduleManifest = {
  id: "prod-view",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.prod-view"],
  create: () => import("./src/module").then((module) => module.createProdViewModule()),
} satisfies ModuleManifest;
