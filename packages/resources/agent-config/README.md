# @fenix/agent-config

Agent 配置资源行、关联绑定（Skill / MCP / 知识库 / 记忆）与站点应用（Site App）的唯一 owner。

## 职责

- **资源行与授权**：`agent_config` 的注册（`src/server/access/agent-config-resource.ts`：归属列在主表，member 默认只有 `read` / `use`，创建、修改、删除与公开受众设置归 owner / admin）、领域服务（`src/server/services/agent-config-service.ts`，不接收 actor）与资源 Facade（`src/server/facades/agent-config-facade.ts`：授权编排 + 停止实例 / 清理绑定 Environment / 重启实例等跨资源副作用）。受控读取的授权谓词由注入的 `AccessControlModule` 编译，仓储不判断组织、角色与 `visibility`。
- **关联绑定**：`createAgentAssociations()`（`src/server/services/agent-associations.ts`）是五类绑定的统一门面——绑定表分散在各自资源包，路由与 Facade 经它读写，不在协议层散落跨包导入。
- **站点应用**：`agent_site_app` 仓储（`src/server/repositories/agent-site-app.ts`）、`/agent-sites` 路由、L3 业务前端代理 `/web/site/deploy/:appId/*`（`src/server/routes/agent-sites-proxy.ts`，60s LRU + `/app-xxx/*` 兜底兼容层）与浏览器组件（`SiteFrame` / `SiteTabsBar` / `MountSiteDialog` / `AgentSitesPage`）。
- **协议交付物**：`/web/config/agents`、`/web/agent-sites`、`/web/sidebar-config`、`/web/agent-generation` 与 `/api/agents`。
- **系统入口**：`src/server/system-entries.ts` 提供 `getAgentConfigById`（无授权读，供 LaunchSpec 构建 / Observer 展示 / acp-ws 归属解析）与 `getReadableAgentConfigById`（按组织可见性读的迁移期兼容入口）。
- **meta-agent 托管**：`src/services/meta-agent.ts` 管理 `meta-agent` Environment 生命周期与 `.agents/skills/` 内置 Skill 装载，`syncBuiltinSkillsToSystemAdmin` 供宿主启动同步。
- **组合根**：`createAgentConfigServerModule(deps)`（`src/server/module.ts`，依赖全部由宿主注入：`accessControl` / `scopeStore` / `authorizedQuery` / `identity`），结果经 `installAgentConfigModule` 装入 `src/server/runtime.ts` 的进程单例，未装配即报错而不静默退化。
- **浏览器出口**：`src/index.ts` 重导出 `web/api/agents`、`web/api/sites` 与 agent-panel 组件；`src/__tests__/browser-surface.test.ts` 静态守住「不重导出服务端模块」这条边界，完整依赖图由 Vite 生产构建验证。

## 依赖边界

- 本包属 `resources`；`dependsOn: ["knowledge","mcp","memory","skill"]`，四条边都是关联绑定读写带来的成套启用耦合，逐条代码证据见 `fenix.module.ts`。
- 反方向由对方声明：machine（`remote-file-service.ts` 读 Agent 配置与 AgentNode）、model-management、observer 都导入本包服务端入口；本包不写这些边，写了会反转装配方向。
- 跨包只经公开子路径（`@fenix/resource-*/server*`），不引用对方 `src/**`；身份展示经 `@fenix/platform-sdk` 的 `IdentityDirectory`，授权经 `AccessControlModule`——本包不 import 任何具体实现。
- `apps/server` 是唯一合法装配者（装配模块、挂载路由、启动时同步内置 Skill）。

## 守卫由宿主注入

**目标形状，当前尚未成立**。本包路由仍是直接构造的 Elysia 实例（`export default app`），并在文件内导入宿主守卫 `authGuardPlugin`（`@server/plugins/auth`，生产代码 8 个文件）：`webConfigAgentsRoutes` / `apiAgentsRoutes` / `webAgentSitesRoutes` / `webAgentGenerationRoutes` 经 `.use(authGuardPlugin)` 生效，`agent-sites-proxy.ts` 另用 `authenticateRequest`，`system-entries.ts` 与 `meta-agent.ts` 用 `toActorContext`。

Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填；而守卫必须与宿主的认证解析（含 `setTestAuth` 测试 seam 与组织上下文）是同一份实例，两份同名实例会被按 plugin `name` 去重、先构造的一方静默生效。因此目标形状与黄金样本 `@fenix/resource-sandbox` 一致：路由以**工厂**导出、守卫由宿主注入，`@server/plugins/auth` 导入清零。改造归任务 1.3 W2 切片——现在单方面发明工厂签名会与 §1.5 的宿主挂载形状分叉。

## 配置与 DB

- **不读模块配置**：`getModuleConfig` 零调用。`./server/testing` 提供的是模块替身而非配置形状：`createStubAgentConfigFacade` / `createStubAgentConfigService` / `createStubAgentAssociations` / `createStubIdentityDirectory` / `createStubAgentConfigServerModule` 与 `resetAgentConfigModuleForTesting`，未打桩的方法直接抛错，宿主用例（`apps/server/src/__tests__/config-integration.test.ts`）经它注入。
- **运行时 env 仍由 `process.env` 直读**：`AGENT_SITES_BASE_URL` / `AGENT_SITES_MASTER_KEY`（`src/server/services/agent-sites.ts`）、`OPENAI_API_KEY` / `OPENAI_MODEL`（`src/server/services/agent-generation.ts`）、`APP_HIDDEN_SIDEBAR_TABS`（`src/services/sidebar-config.ts`）。
- **DB**：`agent_config` / `agent_site_app` / `environment` 等表从 `@server/db/schema` 导入（含仓储与两个 `@server/db` 直连的站点路由支持文件）。受控读取的谓词由平台查询编译器下推，写路径直接经 `db` 执行、授权在 Facade 完成。
- `src/server/repositories/agent-config.ts` 与资源行仓储职责分开：前者是编排域 `AgentConfigRepo` 的 PG 实现，一次 JOIN 返回内嵌 skills / mcpServers / knowledgeBases 的扁平聚合。

## 边界外的已知项

- **没有 `web/index.ts`**：`exports["./web"]` 指向 `./src/index.ts`（与 `"."` 同一文件，即浏览器入口）。正确形状是 `./web → ./web/index.ts`（sandbox 已切换）；归 W2 切片。
- **路由非工厂形态**：见上节，`@server/plugins/auth` 生产残留 8 文件；归 W2 切片，宿主侧接线归 §1.5。
- **没有 `src/module.ts`**：registry 驱动的模块工厂入口缺席，模块组合根是 `src/server/module.ts` 的 `createAgentConfigServerModule` + `src/server/runtime.ts` 的手工单例；归 W2 切片。
- **表定义仍导入 `@server/db/schema`**：本包生产代码共 17 个文件导入 `@server/*`（auth 8、db 8，其余为宿主 config-utils / user-config / sidebar-config schema），表定义迁出归 §1.7。
- **env 未收敛**：`process.env` 直读与 `envDefinitions` 的宿主登记归 §1.7。
- **web 侧宿主别名**：`@/src/**`、`@/components/**` 89 处，另有浏览器侧 `@fenix/resource-sandbox/web` 1 处；归 §1.6（`web-package-not-to-app`）。
- **未声明 `contributions` / `web` manifest 字段**：形状须与 §1.5 宿主挂载、§1.6 WebShell 装配同时定稿。
