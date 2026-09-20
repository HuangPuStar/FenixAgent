# @fenix/resource-mcp

受控 MCP Server 资源（增删改查、启停、远程检测、tool 缓存与 Agent 绑定）的唯一 owner。

## 职责

- **资源语义与归属列**：`src/server/access/mcp-server-resource.ts` 声明 `mcp_server` 的 `ownershipMode: "organization"`、动作集 `read / create / update / delete / use`、member 默认 `read / use`、`public` 默认 `read`；归属列直接在主表（`organization_id` / `user_id` / `visibility`），创建期归属由 `AccessControlModule.resolveInitialScope` 与 INSERT 同批写入，不需要 side-table 初始化。
- **应用入口**：`McpServerFacade`（`src/server/facades/`）是唯一应用入口，链路为 `route → Facade → Domain Service → Repository`。授权判断全部继承 `AccessControlModule`，本包不复制组织/角色/`visibility` 规则；`ResourceAccessDeniedError` 在这里映射为 403，其余错误原样上抛，存储或装配故障不会被伪装成权限问题。
- **领域服务**：`createMcpServerService` 只做资源键解析（`<organizationId>/<resourceId>`）、类型归一与 tool 缓存编排，不认识 actor；`upsertSystemServer` 是系统托管写入路径（宿主 `services/config/mcp-system-server.ts` 为 Hindsight 等按固定名调用），单独命名以免与受控创建路径混用。
- **持久化**：受控读取一律经 `AuthorizedResourceQuery` 端口，授权谓词、排序与分页由平台实现编译进同一条 SQL，`total` 是当前主体可见资源的真实总数；写路径与 `mcp_tool` 缓存不经授权端口，因为权限校验已在 Facade 完成。
- **远程检测与 tool 缓存**：`inspectRemoteMcpServer` 用 MCP SDK 的 `Client` 先试 Streamable HTTP、失败回退 SSE，超时经 `AbortController` 中断，两条路径都关闭 client 与 transport；检测结果由 Facade 写入 `mcp_tool`（`replaceTools` 全量覆盖），删除资源时与缓存同事务清理，`/actions/tools` 读的是这份缓存而不是实时探测。
- **`/web` 视图**：列表与详情返回归属 `scope` 与当前主体有效动作 `access.actions`，不再返回旧栈的 `resourceAccess`；`organizationName` 是展示字段，由身份目录批量解析，不在资源层二次推导。
- **配置模型**：`src/server/services/config/mcp-config.ts` 是 `McpServerConfig` / `validateMcpConfig` / `toServerInfo` 的定义方，宿主 `services/config/types.ts` 只再导出；`parseMcpConfigValue` 兼容历史上双重编码的 jsonb 字符串行。
- **HTTP 交付物**：`/web/config/mcp`（RESTful CRUD + `/actions/enable|disable|test|test-url|inspect|tools`）、`/api/mcp`（对外已发布合同，也是唯一保留 `resourceAccess` 派生字段的位置）、`/mcp/knowledge`（内部协议入口，Bearer environment secret 自鉴权，暴露 `kb_search` / `kb_read` / `kb_graph_get`）。
- **前端**：`web/pages/agent-panel/pages/` 的 `AgentMcpPage` 与目录/对话框/工具函数、`web/api/mcp.ts` 客户端、`web/lib/mcp-resource-access.ts` 授权判断（缺 `scope` / `access` 时按「本组织私有、不可写」保守降级）、`web/i18n/locales/{zh,en}/mcp.json`。
- **装配与出口**：`createMcpServerServerModule(deps)` 的依赖全部由宿主注入，包内不保存进程级单例；`installMcpServerModule` / `getMcpServerModule` 是同一份装配结果的写入与读取点，未装配即报错而非静默兜底。根出口 `src/index.ts` 为空，服务端实现一律经 `./server` 取。

## 依赖边界

本包属 `resources` 类别，依赖矩阵禁止 `resources → platform-impl`：

- 不导入 `@fenix/identity/*` 或 `@fenix/access-control/*`，`src/server/module.ts` 只在注释里点名二者；授权走注入的 `AccessControlModule` 接口，身份展示经 `@fenix/platform-sdk` 的 `IdentityDirectory` 窄契约。
- 跨资源只经对方包根入口：`@fenix/resource-knowledge/server` 的三个 for-agent service，即 `fenix.module.ts` 中 `dependsOn: ["knowledge"]` 的代码证据。
- 不引用其它资源包的 `src/**`、repository 或 schema；`@fenix/agent-runtime/server` 只取 `getEnvironmentBySecret`（Bearer token → environment）。

## 守卫由宿主注入

现状与黄金样本（sandbox）的「工厂 + 守卫注入」形态**不同**：`/web/config/mcp` 与 `/api/mcp` 在包内 `import { authGuardPlugin } from "@server/plugins/auth"`，并以 `export default` 导出已构造的 Elysia 单例；`/mcp/knowledge` 不走守卫，用 `getEnvironmentBySecret` 校验 Bearer token。这条宿主内部依赖归 §1.5 的资源依赖收敛（台账 `apps-boundary`, owner 1.5）。目标形态是路由导出工厂、由宿主注入与 `setTestAuth` 同源的守卫实例。包内测试覆盖已发布协议行为（`src/__tests__/round40`、`round47`、`round66` 等），注入守卫后的合同由宿主用例继续覆盖。

## 配置与 DB

- 不读 `process.env`、不读 `.env`；配置模型是纯函数（无 IO、无权限判断），部署级变量与 `envDefinitions` 收敛在 §1.7。
- DB 由 `src/server/repositories/mcp-server.ts` 与 `agent-config-mcp.ts` 直接经 `@server/db` 与 `@server/db/schema` 的 `mcp_server` / `mcp_tool` / `agent_config_mcp` 访问——表定义仍在宿主，是本包唯一的宿主内部依赖，迁出归 §1.7。
- 受控读取不拼裸 SQL：只交出主表、归属列与业务条件，授权谓词由平台实现编译进同一条查询。

## 边界外的已知项

- **没有 `web/index.ts` 浏览器出口**：`web/` 下只有页面、页面私有组件、api client 与 i18n 资源，`package.json` 也没有 `./web` 条目；宿主 `apps/web/vite.config.ts` 用 alias 直接指向包内 `web/api/mcp.ts`、`web/lib/mcp-resource-access.ts`、`web/pages/agent-panel/pages/AgentMcpPage.tsx`。归 §1.6 WebShell 装配。
- **路由是 default export 而非工厂**：见「守卫由宿主注入」，归 §1.5。
- **没有 `src/module.ts` 单例**：组合根目前由宿主 `main.ts` 显式调用 `createMcpServerServerModule` 后 `installMcpServerModule` 装入；manifest 因而不声明 `create`，归 W2 切片。
- **表定义仍导入 `@server/db/schema`**：归 §1.7。
- **`contributions` / `web` 未声明**：消费方是 §1.5 与 §1.6，形状需与消费端同时定型，单方面发明会返工。
