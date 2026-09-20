# @fenix/resource-memory

Hindsight 长期记忆在平台内的唯一 owner：记忆可用性判定、Hindsight MCP server 与 bank 的幂等登记，以及 `/web/hindsight/**` 代理路由。

## 职责

- **记忆开关（权威判断入口）**：`src/server/services/agent-memory.ts` 的两级模型——系统级 `isHindsightAvailable()`（`HINDSIGHT_MCP_URL` 是否配置）与 Agent 级 `isAgentMemoryEnabled(agentConfigId)`（`agent_memory_config.enabled`），由 `shouldEnableAgentMemory()` 组合。需要判断「记忆能否生效」的调用方必须经此入口，不得各自内联查表或解析 `extra.plugin`。
- **插件默认参数**：`HINDSIGHT_PLUGIN_DEFAULTS` 是 Hindsight 插件的运行时默认值（不落库），由启动参数构造方（`@fenix/agent-runtime` 的 launch spec）消费。
- **bank 与 MCP 登记**：`ensureHindsightMcpServer(ctx)` 先用 `getIdentityDirectory().resolveMembershipId()` 把「当前用户在活跃组织下的 member id」解析为 bank ID（不直查身份表），再幂等写入系统托管的 MCP server 条目（`upsertSystemMcpServer`），最后 `ensureBank()` 以 `PUT /v1/default/banks/{bankId}` 保证 bank 存在。
- **上游转发**：`proxyToHindsight()` 是所有 Hindsight 调用的唯一出口；`src/server/routes/web/hindsight.ts` 在其上实现 `/web/hindsight/*`（status、graph、bank-stats、memories、recall、reflect、documents、mental-models、entities），逐路由补齐 OpenAPI `detail`；除 status 外都把不可解析的 bank ID 映射为 403、上游不可达映射为 503。
- **数据访问**：`src/server/repositories/agent-memory-config.ts` 是 `agent_memory_config` 的唯一读写点（`getByAgentConfigId` / `setEnabled` 幂等 upsert）。
- **浏览器面**：`web/pages/hindsight/MemoriesPage.tsx` 加 12 个组件构成五种视角（世界事实 / 经验 / 观察 / 心理模型 / 实体）的记忆控制台，API client 在 `web/api/hindsight.ts`，文案在 `web/i18n/locales/{zh,en}/hindsight.json`。

## 依赖边界

本包属 `resources` 类别，是依赖图上的叶子：`fenix.module.ts` 的 `dependsOn` 为空。

- 服务端 `src/**` 的 workspace 导入只有 `@fenix/platform-sdk/server`（身份目录窄契约）；platform-sdk 是契约包、不注册模块，不构成装配边。
- 其余导入落在宿主应用内部（`@server/db`、`@server/db/schema`、`@server/plugins/auth`、`@server/services/config`、`@server/services/config-utils`，实测 6 处 / 3 个生产文件），由台账 `apps-boundary` 登记（owner 1.5，其中表定义一行归 §1.7），不是模块依赖。
- 入边不写进本包：`@fenix/agent-config/src/server/services/agent-associations.ts` 与 `@fenix/agent-runtime/src/services/launch-spec-builder.ts` 都值导入本包 `/server`，前者由 agent-config 的 manifest 声明这条边，后者是台账 `agent-runtime-not-to-resources`（owner 1.4）的越界边，须消除而不是编码成装配依赖。

## 守卫由宿主注入

本包**尚未**改造为「工厂 + 守卫注入」形态：`src/server/routes/web/hindsight.ts` 直接 `import { authGuardPlugin } from "@server/plugins/auth"`，在模块作用域构造 Elysia 实例并 `export default app`；宿主 `apps/server/src/routes/web/index.ts` 以 `.use(webHindsight)` 挂载它，`sessionAuth: true` 与该 macro 注入的 `store.authContext` 都来自这份宿主守卫。

之所以不能只改包内：守卫必须与宿主的认证解析（含 `setTestAuth` seam 与组织上下文）是同一份实例，Elysia 的 macro / state 是实例作用域的，父实例无法向已构造的子实例回填；改造成工厂要连同宿主挂载点一起改，属 W2 切片的边界切断范围，届时 `@server/plugins/auth` 与 `@server/services/config-utils` 的导入一并消失。包内用例（`src/__tests__/` 3 个文件、`web/__tests__/` 2 个文件）目前经宿主 `setTestAuth` / `setTestOrgContext` 注入上下文，并 stub `IdentityDirectory` 与 `fetch`。

## 配置与 DB

- **配置**：`HINDSIGHT_MCP_URL` 由宿主 `apps/server/src/env.ts` 声明为可选，但本包在 `src/server/services/hindsight.ts`（`getHindsightConfig()`）与 `src/server/services/agent-memory.ts`（`isHindsightAvailable()`）直接读 `process.env`；改经 `getModuleConfig("memory")` 或注入属 W2 切片，`envDefinitions` 的宿主登记归 §1.7。宿主 `apps/server/src/main.ts` 的 `initializeApplicationInfrastructure()` 目前只为 `identity` 与 `sandbox` 注册了模块配置，memory 尚无槽位。未配置时 status 返回 `enabled: false`，其余路由由 `proxyToHindsight()` 抛错并被路由捕获映射为 503。
- **DB**：只经 repository 使用宿主 `@server/db` 句柄与 `@server/db/schema` 的 `agentMemoryConfig` 表；表定义、DDL 与迁移归 §1.7。
- **凭据**：本包不读取 `HINDSIGHT_API_TOKEN`（它由 `@fenix/agent-runtime` 的启动参数与 `@fenix/plugin-ccb` 透传给 Agent 进程）；除上游 URL 外不持有任何密钥，也不写日志。

## 边界外的已知项

- **没有 `web/index.ts` 浏览器出口**：`package.json` 只有 `.`（`src/index.ts`，当前是 `export {}` 的浏览器安全占位）与 `./server`；页面与 API client 正被宿主用 `apps/web/vite.config.ts` 的 `@/src/api/hindsight`、`@/src/pages/hindsight/MemoriesPage` 别名直连文件（包内 `tsconfig.json` 有同名映射）。`./web` 出口面归 W2 切片，导航与路由收集归 §1.6 WebShell。
- **路由仍是 default export**：见上节，改造为「工厂 + 守卫注入」属 W2 切片，宿主改用工厂的挂载点改动归 §1.5。
- **没有 `src/module.ts` 单例**：`fenix.module.ts` 因此不声明 `create`；组合根与进程级单例归 W2 切片。
- **表定义仍导入 `@server/db/schema`**：`agent_memory_config` 的列定义留在宿主，迁出归 §1.7；本包只做 repository 读写。
- **web 依赖与别名未自持**：`web/**` 实测 46 处 / 13 文件的宿主别名（`@/src/*`、`@/components/ui/*`），台账 `web-package-not-to-app`（owner 1.6）登记；react、react-i18next、lucide-react、cytoscape、`@chenglou/pretext`、react-markdown 等第三方依赖也未写入本包 `dependencies`，靠宿主依赖树解析。别名切断归 W2 切片（tsconfig 失效映射同批删除），web 依赖声明规则归 T2e。
