import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * ProdView（发布视图）资源模块描述符。
 *
 * 「Agent 配置 + 一组 Chat 模块开关 → 可对外分享的只读视图」这一能力的唯一 owner：领域规则、持久化
 * 与 HTTP 交付物都在本包服务端——`/web/config/prod-views` 的管理 CRUD，以及 `/web/prod-views/:id/load`
 * （把视图解析为 `agentConfigId + environmentId + instanceUid + modulesConfig`，浏览器据此连到该用户的
 * 持久实例；只解析实例身份，不预启动 runtime）。装配面上的消费者是宿主 `apps/server`：`routes/web/index.ts`
 * 与 `routes/web/config/index.ts` 分别 `.use()` 本包的两个路由实例。
 *
 * `dependsOn: []`（叶子模块）。按代码实测，本包服务端生产代码没有任何指向已注册**资源**模块的值导入：
 *
 * - 唯一的跨包值导入是 `src/server/services/prod-view.ts` 的 `@fenix/agent-runtime/server`
 *   （`createWebEnvironment` 建视图专用 environment，`agentInstanceService.findOrCreateDefaultInstance`
 *   解析该用户的持久实例）。agent-runtime 是 `agent-runtime` 类别的基础模块，在 profile 里是固定槽位
 *   （`requireFoundation` 总是启用），不进入资源模块的装配依赖校验范围；该跨类别边由 §2.3 依赖矩阵与
 *   架构台账负责（owner 1.4）。
 * - `@fenix/platform-sdk` 是契约包，没有模块 ID 可声明；`@server/db` / `@server/db/schema` /
 *   `@server/plugins/auth` 是宿主内部路径（台账 `apps-boundary`，owner 1.5；其中表定义迁出归 §1.7），
 *   必须消除而不是编码成装配依赖——台账本身受「不再违规即删除」校验，无法用来长期豁免。
 * - web 侧的 `@fenix/chat-channel/web/chat-area`（`web/pages/prod-view/ProdViewPage.tsx` 的 lazy import）
 *   是浏览器面耦合：web 贡献不进入服务端装配顺序，其启用由 profile 的 `web` 列表表达（§1.6）；且
 *   chat-channel 尚无 manifest，没有模块 ID 可声明。
 *
 * 不声明 `create`：模块组合根（`src/module.ts` 的进程级单例）属任务 1.3 W2 切片。不声明
 * `contributions` / `web` / `envDefinitions`：前两者的消费方分别是 §1.5 的宿主挂载与 §1.6 的 WebShell
 * 装配，形状必须与消费端同时定型；`envDefinitions` 的宿主登记归 §1.7（本包不读 `process.env`）。
 */
export const moduleManifest = {
  id: "prod-view",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.prod-view"],
} satisfies ModuleManifest;
