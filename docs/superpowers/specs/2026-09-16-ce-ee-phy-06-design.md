# CE-EE 阶段 1 PHY-06：AgentConfig、模板与 Site App 物理迁移设计

## 目标

将 AgentConfig、Agent 模板、配置关联选择器及 Agent Site App 的完整现有业务闭包从根 `src/`、`web/` 物理迁入 `packages/resources/agent-config`，并保持既有控制台、外部 Agent API、站点发布与代理协议完全不变。

本任务仅重定位实现和更新必要的包出口、宿主装配、浏览器 alias、测试路径与跨闭包调用；不改变数据库、认证、授权、路由 URI、请求响应、并发语义或生命周期。包名沿用已有 workspace 骨架的 `@fenix/agent-config`，不另建名称相近的资源包。

## 范围与唯一 owner

`@fenix/agent-config` 是下列能力的唯一 owner：

- AgentConfig 的 repository、校验、创建/读取/更新/删除、默认 Agent、运行实例重启和关联资源绑定；
- Agent 模板的 `gray-matter` 解析与模板列表接口；
- `/web/config/agents` 的所有保留 action/name 语义和 `/api/agents` 的外部 API；
- Agent 生成及其 system prompt 相关服务、schema 与 `/web` 路由；
- Site App 的 repository、远程 `agent-sites` 客户端、控制台管理 API、发布/上传、绑定/解绑和公开代理入口；
- 直属的前端 API、Agent 配置编辑/创建、模板选择与 Site 页面、组件、样式、i18n、路由薄适配和测试。

`agent_config`、`agent_site_app` 及关联表的 schema 真相仍由 `apps/server/src/db/schema.ts` 持有；本任务不生成 Drizzle migration、DDL 或 data migration。`@fenix/agent-runtime` 仍拥有 Environment、Instance 和 relay/runtime 生命周期；AgentConfig 只调用其既有 restart/查询公开接口。Skill、MCP、Knowledge、Memory、Model 和 Machine 各自仍由已迁移或后续的资源 owner 持有，AgentConfig 只保留既有编排与选择绑定。

## 模块边界和数据流

```text
apps/server (认证、旧路径注册、DB/运行时宿主)
  -> @fenix/agent-config/server (AgentConfig/Site 的 route contribution 与领域服务)
    -> 已有资源包公开 server 接口 / apps/server DB schema
apps/web 路由薄适配
  -> @fenix/agent-config 的浏览器专属文件（经 Vite alias）
    -> /web/config/agents、/web/agent-sites、/api/agents 与原 site proxy 路径
```

后端公开入口必须与浏览器入口分离：`@fenix/agent-config/server` 可供宿主和其他后端闭包消费；默认浏览器入口只导出浏览器安全的类型、API 和 UI contribution，绝不经值导入 re-export Node、Elysia、Drizzle、文件系统或持有平台代理密钥的模块。

原路由继续由 `apps/server/src/main.ts` 在原顺序注册。`/web/config/agents` 必须保留 `name` query、templates/default/restart action 与 `{ success, data }` 错误映射；`/api/agents` 保留 API Key/session 认证后的可读资源、内置 Agent 删除限制和稳定 OpenAPI 结构。Site App 继续按组织/用户隔离 token，发布与上传的远端错误、客户端取消、代理 cookie 剥离和响应头处理均不改变。

## 迁移方法

1. 补齐包的 `package.json`、TypeScript 配置及 `src/index.ts`/`src/server.ts` 双入口，按现有资源包模式声明准确 workspace 依赖。
2. 使用 `git mv` 将 AgentConfig、Agent 模板、Agent generation、Site App 的 repository、service、schema、route、直属测试及浏览器文件移动到包内对应的 `src/server/` 与 `web/` 子路径。仅当现有单文件超过工程 500 行上限时，按职责拆分为私有模块，保持导出的路由、函数和实际调用顺序不变。
3. 将宿主、运行时、其他资源包和测试改为导入 `@fenix/agent-config/server` 的稳定公共接口；跨资源的 Skill/MCP/Knowledge/Memory/Model/Machine 继续使用各自已有的公开接口，不复制源码或恢复旧根路径。
4. 将 `apps/web` Vite alias、路由薄适配和前端引用指向包内浏览器文件，保持 URL、i18n key、用户流程、加载/错误/重试和可访问性行为不变。
5. 删除已完整迁移的根路径源文件及其所有运行/测试 import；不保留 root re-export、deprecated shim、双写或兼容副本。

## 验证与验收

迁移前后以专项后端和前端测试验证：

- AgentConfig 字段校验、`top_p` 别名、内置 Agent、创建/更新/删除、默认选择、实例重启及跨组织资源权限；
- `/web/config/agents` 的 action/name 合同、`/api/agents` 的 API Key 回归与读写边界；
- 模板以 Markdown + YAML frontmatter 经 `gray-matter` 解析，隔离且不暴露文件系统细节；
- Site App 的组织隔离、CRUD、绑定幂等、token 轮换、发布/上传、断开取消和 proxy 行为；
- 浏览器导入图不加载 server 入口，`bun run build:web` 能构建真实生产静态产物。

完成闭包后运行相关 `bun test`、包 typecheck、`bun run build:web` 和 `bun run precheck`。若确认某测试仅因全局 mock/stub 泄漏而不能表达本闭包行为，按任务授权删除该测试，并在未提交的 `task-result.md` 记录命令、证据与原因。

## 不做项与风险边界

不改变 AgentConfig、Site App 或任何资源表的 schema/DDL，不调整认证、资源权限、组织隔离、外部协议、Docker/CI 或部署流程；这些均不属于 PHY-06。若实际迁移需要改变上述高影响合同，停止该闭包的实现，将原因、受影响路径与阻塞证据追加到未提交的 `task-result.md`，然后转向下一项可做任务。

本阶段的删除条件是：包内已承接完整现有闭包、宿主使用公开入口原样装配、根路径无源文件且全仓对已迁移路径的运行/测试 import 为零。PHY-10 不承接本闭包遗留业务。
