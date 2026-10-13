# @fenix/resource-plugin-market

受控资源「市场条目」的唯一 owner：服务端实现（领域规则、npm 私有源读取、`/web` 路由）、浏览器出口与文案都在本包内。模块由 `open-mcp-market/packages/mcp-market` 移植而来，领域模型原样保留：**一个插件 = 一个 NPM package**，稳定身份 `(source_id, package_name)`；**一个插件版本 = 一个 exact version**；`package.json#mcpp` 携带分发元数据（0..n 个 agent / skill / MCP server 成员），发布后在市场内冻结为不可变快照。

## 职责

- **资源语义与归属列**：`src/server/access/plugin-package-resource.ts` 声明 `plugin_market_package` 的 `ownershipMode: "organization"`、动作集 `read / create / update / delete`、member 默认 `read`、public 默认 `read`；归属列直接在主表（`organization_id` / `owner_user_id` / `visibility`），创建期归属由 `AccessControlModule.resolveInitialScope` 与 INSERT 同批写入。**这份定义同时表达「平台全局目录」**：`visibility = 'public'` 叠加 `publicDefaultActions: ["read"]` 让任意已认证主体可读，写权落在归属组织（固定为身份表里 `slug = 'admin'` 的系统托管租户）的 owner / admin 上——实际效果即「只有平台系统管理员能发布、下架、恢复」。这不是一等语义的 `platform` ownershipMode，代价与升级条件写在 `src/server/module.ts` 与资源注册的文件头。
- **应用入口**：`src/server/facades/plugin-package-facade.ts` 是唯一应用入口，链路为 `route → Facade → Domain Service → Repository`。授权判断全部继承 `AccessControlModule`，本包不复制组织、角色或 `visibility` 规则。**读口径由写权推出**（`resolveReadScope`）：写权主体看得到整包下架的条目，其余人只看公开面——因此「下架」对作者是可逆操作，对读者是消失。
- **网络读取的边界**：只有两条路径访问 npm 私有源——`preview` 与「确认发布但库内没有该版本」。恢复与幂等分支**永不出网**，它们复用市场内的冻结快照。发布确认时服务端重读私有源并与 `previewDigest` 比对，不一致即 409 `PREVIEW_CHANGED`（响应体带新快照，前端原地重新确认）。
- **领域规则是纯函数**：`src/server/domain/catalog.ts` 产出**写清单**（`CatalogWrite[]`），由仓储在同一事务里按序执行。这么做的理由是测试进程不连 Postgres：把规则写进 SQL 会让幂等、latest 回退、逻辑时钟、三条不变量失去可执行断言；写成纯函数后「`noop` 零副作用」就是可断言的性质（清单为空）。`domain/invariants.ts` 的 `findInvariantViolations` 同样收内存状态，供测试与运维只读诊断。
- **持久化**：`db/schema.ts` 是三张表（`plugin_market_package` / `plugin_market_publication` / `plugin_market_admin_operation`）的唯一真相来源，经 `./db` 出口公开。受控读取一律经 `AuthorizedResourceQuery` 端口（`repositories/plugin-package-read.ts`），包级可见性（`latest_publication_id IS NOT NULL`）作为 `businessWhere` **下推**给授权查询，不在应用层过滤——应用层过滤会让 `total` 与 `items` 不一致。写路径经 `repositories/plugin-package.ts`，全程持有事务级咨询锁（`withPackageLock`，键 `fenix:plugin-market:<sourceId>:<packageName>`）。
- **存储层不变量**：复合外键（latest 必须指向本包版本）、唯一索引（同包同版本只发布一次）、`CHECK (published_at >= first_published_at)` 由 DDL 强保证；「latest 必须指向可见版本」「被 latest 指向的版本不得隐藏」由应用层顺序保证（先移指针再置水印）+ 只读检查覆盖。源项目用 3 条 SQLite 触发器表达后两条，本仓库迁移链全部由 Drizzle 生成、禁止手写 SQL，故降为「应用层 + 可测断言」，取舍写在 `db/schema.ts` 文件头。
- **私有源快照契约**：`src/server/npm-registry/types.ts` 是**安全边界而不是数据形状**——它是「registry 的不可信 JSON」与「市场自己的可信存储」之间唯一的过桥形式，原始 packument 与任何未列出的字段永远不进市场存储。规范性校验在 `normalize.ts`：22 项 `LIMITS`、6 条 secret 正则、迭代式深度探测（`maxJsonDepth: 12`）、SRI 形状校验、`mcpp.schemaVersion === 1`。**市场不下载、不解压、不扫描 tarball**：`tarballUrl` 只作溯源文本，前端也只渲染不请求。
- **HTTP 交付物**：`/web/config/plugin-market/*` 共 6 条（`GET packages` 全量列表、`GET packages/:slug` 详情、`POST publish/preview`、`POST publish`、`POST unpublish`、`POST restore`），出口 `createWebPluginMarketConfigRoutes(deps)`，挂在宿主 `web-config` 槽。路由是**工厂而非实例**：`sessionAuth` 宏与 `store.actor` 由宿主守卫写入，父实例无法向已构造的子实例回填，故守卫必须由宿主注入。错误码是封闭清单（`src/server/errors.ts`），只收本模块真的会抛的码，每条都有产出点与消费点。
- **浏览器出口**：`web/index.ts` 是跨包消费的唯一公开面，转出 `PluginMarketPage`、`pluginMarketApi` 客户端、目录纯函数（过滤 / 计数 / 选中解析 / 格式化）与 `PLUGIN_MARKET_NS` / `pluginMarketResources`；宿主「插件市场」页（路由 `apps/web/src/routes/agent/_panel/mcp.tsx`）的 npm tab 经 `lazy()` 取页面，`apps/web/src/i18n/index.ts` 登记 NS 与语言资源。**本包没有自己的侧栏项**：npm 市场与 MCP 市场同页不同 tab（`?tab=npm`），tab 状态归宿主路由壳，包内组件保持无壳。该入口的浏览器安全性由 `web/__tests__/plugin-market-browser-surface.test.ts` 静态走值导入图守护（含反例注入）。
- **页面状态语义**：首屏加载走骨架 + 容器 `aria-busy` + sr-only `role="status"`；加载失败按 `isUnauthorizedError` 分叉——401/403 归一后的 `UNAUTHORIZED` 只给说明、**不给重试**（重试不改变授权结果），其余故障保留重试入口；空态区分「无资源」与「筛选无结果」。写动作**不做 `unwrap`**：409 `PREVIEW_CHANGED` 必须把新快照交回弹窗，因此容器显式判断 `success`；`noop`（版本已在市场中）也是成功但文案不同，否则用户会以为私有源上的新内容已进市场。市场条目不是 Agent 的运行时配置，写入后**不广播** `dispatchConfigChange`。
- **装配**：`fenix.module.ts` 是 `ModuleManifest`（`dependsOn: []`、`accessControlBindings`、`envDefinitions` 五键、`contributions` 一条 `web-config` 路由；**不声明 `web`**——该字段要求 `web.id` 与一个导航项 id 同名，而本市场不是侧栏项，它是「插件市场」页（`/agent/mcp`）下的 `?tab=npm` 这一个 tab，页面由宿主路由壳直接 import 本包 `./web` 出口，因此 `package.json` 也不再声明 `./web/contribution`、`ce.json` 的 `web` 列表里没有本包（与 `channel` / `prod-view` 同形：有宿主路由、无导航项））；`src/module.ts` 的 `createPluginMarketModule(context)` 是 registry 的 `create` 目标，补齐「依赖从哪来」并装入进程级槽位；真实构造在 `src/server/module.ts` 的 `createPluginMarketServerModule(deps)`，依赖为注入的 `accessControl` / `scopeStore` / `authorizedQuery`（经 `narrowAuthorizedQuery` 收窄存储类型）与 `IdentityDirectory`。装配结果**只暴露 Facade**，不暴露 Domain Service——市场没有系统初始化写入路径。

## 依赖边界

本包属 `resources` 类别，依赖矩阵禁止 `resources → platform-impl`：源码里的 `@fenix/*` 说明符**实测只有** `@fenix/platform-sdk`（含 `/server`、`/testing`）、本包 `./db`、`@fenix/ui-components/*`（10 个子路径）与 `@fenix/web-runtime/{api/request,types/config}`——不导入 `@fenix/identity/*` 或 `@fenix/access-control/*`，授权走注入端口、身份展示经窄契约。`db/schema.ts` 按外键目标导入 `@fenix/identity/db` 的 `user` 表对象，属迁移链层面的列对象来源（组装期例外，口径见 `docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §6.1），因此 `package.json` 必须声明 `@fenix/identity` 但不进 `dependsOn`。实测 `grep -rn 'from "@server/' src web fenix.module.ts` → **0 条**，包内不读 `process.env`（`grep -rn "process\.env"` → 仅 1 条注释）。

## 环境变量

五个 `PLUGIN_MARKET_*` 键在 `fenix.module.ts` 的 `envDefinitions` 声明（**全部 optional 或带默认值**，一个都不能 required：`assembly-env.test.ts` 用空输入跑真实清单，required 会让整条 CE 装配线启动期失败），由宿主 `apps/server/src/bootstrap/module-configs.ts` 经 `readDeclaredEnv` 投影，包内 `src/server/config.ts` 只读注入值。

| 键 | 含义 |
|---|---|
| `PLUGIN_MARKET_REGISTRY_URL` | 私有源 base URL。**未配置时只有发布与预览路径失败**（`REGISTRY_NOT_CONFIGURED` 503），浏览既有快照完全不读私有源 |
| `PLUGIN_MARKET_REGISTRY_TOKEN` | 私有源 token；标 `secret: true`，不进日志与响应 |
| `PLUGIN_MARKET_REGISTRY_TIMEOUT_MS` | 单次读取超时 |
| `PLUGIN_MARKET_REGISTRY_MAX_BYTES` | 单次响应体上限（超出即 `METADATA_TOO_LARGE`） |
| `PLUGIN_MARKET_SOURCE_ID` | 来源标识，写入 `source_id`；与包名共同构成聚合根身份 |

## 相对源项目的偏离

移植范围是「只要市场本体」（用户已确认），以下四项**不搬**，此处登记以便后续追溯：

- **`http-source` 第二来源**（MCP over HTTP 发现客户端，约 1000 行）：源项目的设计文档明确它是可加性扩展，npm 路径不受影响。因此快照契约删掉了只由它产出的字段（`SnapshotTool` / `SnapshotResource` / `SnapshotCapabilities` / `sourceKind` 等），没有新增。
- **静态页生成与失效**（`public-site/*` + `public_refresh_attempts` 表）：与部署环境强绑定，SPA 架构下「下架版本绝不被读路径返回」改由 SQL 可见性谓词保证。
- **admin-auth**（env 单账户 + HMAC cookie + CSRF + 内存限流，4 个文件）：整体由 better-auth 多租户替换，相应删掉 `UNAUTHENTICATED` / `FORBIDDEN_ORIGIN` 两个错误码。
- **服务端分页**（源的 `clampLimit` / `clampOffset`，默认 24、上限 60）：列表改为全量返回 + 前端过滤，与本仓其它五个目录页一致（全仓无 `pg_trgm` / `tsvector`，中文子串检索不值得为此引入数据库扩展）。

另删 `CATALOG_CONFLICT`（源项目用它表达 SQLite 里的孤儿行，本仓库从包行出发读取且写路径全程持锁，无产出点）与 `INTERNAL_ERROR`（宿主 `error-handler.ts` 统一落 500）。
