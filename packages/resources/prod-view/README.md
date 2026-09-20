# @fenix/resource-prod-view

把「Agent 配置 + 一组 Chat 模块开关」组装成可对外分享的只读发布视图，并承载视图加载链路的唯一 owner。

## 职责

- **领域规则与持久化**：`src/server/services/prod-view.ts` 提供 create / get / list / update / delete / load 六个用例，全部以 `AuthContext` 的 `organizationId` 作租户边界；`src/server/repositories/prod-view.ts` 是唯一数据访问点（Drizzle 操作 `prodView` 表），service 不写 SQL。
- **HTTP 交付物**：`/web/config/prod-views`（GET 列表、POST 创建、GET/PUT/DELETE `:id`，控制台管理面）与 `/web/prod-views/:id/load`（分享页加载面，要求同组织会话且视图 `enabled=true`）。两者在 `src/server.ts` 以默认导出暴露给宿主。
- **视图加载链路**：`loadProdView` 经 `createWebEnvironment` 建视图专用 environment，再以 `findOrCreateDefaultInstance(envId, userId)` 解析该用户的持久实例，返回 `agentConfigId / environmentId / instanceUid / name / modulesConfig`；只解析实例身份，不预启动 runtime。
- **模块开关模型**：`src/server/schemas/prod-view.schema.ts` 声明 12 个模块键（8 个 Chat 主体 + 4 个附加面板，均 passthrough）；前端纯逻辑 `web/lib/prod-view-modules.ts` 负责默认表（Chat 主体默认开、附加面板默认关）与配置的双向转换。
- **浏览器面**：`web/api/prod-views.ts`（`request` 封装）、`web/pages/agent-panel/**`（控制台列表与编辑面板）、`web/pages/prod-view/ProdViewPage.tsx`（分享页：lazy 加载 `@fenix/chat-channel` 的 ChatArea，以 `prodViewId:environmentId:instanceUid` 作 key，用请求代次守卫拒绝旧响应覆盖新结果）、`web/i18n/{en,zh}/prodViews.json`。

## 依赖边界

本包属 `resources` 类别；`fenix.module.ts` 的 `dependsOn: []` 是叶子模块的实测结论：

- 服务端唯一的跨包值导入是 `@fenix/agent-runtime/server`（`src/server/services/prod-view.ts` 的 `createWebEnvironment` 与 `agentInstanceService`）。agent-runtime 是固定启用的基础模块，不写进 `dependsOn`，该跨类别边归 §2.3 依赖矩阵与架构台账（owner 1.4）。
- `package.json` 里的 `@fenix/chat-channel` 只被 `web/**` 的 lazy import 使用（`ProdViewPage.tsx` → `@fenix/chat-channel/web/chat-area`），web 贡献不构成服务端装配边。
- 其余导入落在宿主内部：`@server/db` / `@server/db/schema`（repository）与 `@server/plugins/auth`（路由守卫与 `AuthContext` 类型），台账记录为 `apps-boundary`（owner 1.5），必须消除而不是编码成装配依赖。
- 反向：宿主 `apps/server` 是唯一的服务端消费者；浏览器面经根 `tsconfig.json` 与 `apps/web/vite.config.ts` 的逐文件别名直连本包 `web/**`（台账 `web-package-not-to-app`，owner 1.6）。

## 守卫由宿主注入

目标形态与 `@fenix/resource-sandbox` 黄金样本一致：路由以**工厂**导出、守卫由宿主注入。理由与沙盒相同——Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填；两份同名实例会被按 plugin `name` 去重，先构造的一方静默生效，因此守卫必须与宿主的认证解析（含 `setTestAuth` 测试 seam 与组织上下文）是同一份实例。

**现状（尚未迁移）**：两个路由文件都以默认导出构造好的 Elysia 实例（`name: "web-prod-views"` / `"web-config-prod-views"`），内部直接 `import { authGuardPlugin } from "@server/plugins/auth"` 并 `.use()`；宿主聚合层同样按实例 `.use()`（`apps/server/src/routes/web/index.ts`、`routes/web/config/index.ts`）。改成 `createWebProdViewsRoutes({ authGuardPlugin })` 属 W2 切片。

## 配置与 DB

- 不读 `process.env` / `.env`，也没有模块级配置项（无 `getModuleConfig`）；`envDefinitions` 的宿主登记归 §1.7。
- DB 经宿主 `@server/db` 的 `db` 句柄与 `@server/db/schema` 的 `prodView` 表：物理表 `prod_view`，`agent_id` 外键指向 `agent_config` 且 `onDelete: cascade`——删除 Agent 配置会级联删除其发布视图。
- repository 是唯一数据访问点，每条查询都带 `organizationId` 谓词；service 只从 `AuthContext` 取 `organizationId` / `userId`（写入 `createdBy`、圈定实例归属）。
- 表定义与迁移仍在宿主（`apps/server/src/db/schema.ts`），迁出归 §1.7。

## 边界外的已知项

- **没有 `web/index.ts` 浏览器出口**：`web/**` 目前只由宿主别名逐文件直连（见「依赖边界」），出口收敛与 i18n 聚合出口（`web/i18n/index.ts`）属 §1.6。
- **路由仍是 default export 实例**，不是「工厂 + 守卫注入」形态（W2）。
- **没有 `src/module.ts` 单例**，因此 manifest 不声明 `create`（W2 切片）。
- **表定义仍导入 `@server/db/schema`**：本包唯一的宿主内部数据依赖，迁出归 §1.7。
- **服务端用例缺口**：`src/__tests__/prod-view-service.test.ts` 在 `a1096215b`（收口全仓测试矩阵，随 20 个依赖全局 mock / 共享 DOM stub 的旧测试删除）一并删除；包内现只剩 `web/__tests__/` 两个用例（模块开关纯逻辑、ProdViewPage 与服务端的静态契约），service / routes 的包内回归用例需在 W2 重建，真实守卫与 `RCS_SYSTEM_API_KEYS` 契约归 §1.5 宿主用例。
- **`AuthContext` 仍是宿主全字段类型**：W2 按 §6.4 收敛为只取 `organizationId` / `userId` 或平台 `ActorContext`。
