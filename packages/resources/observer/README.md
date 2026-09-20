# @fenix/resource-observer

运行中 ACP 链接的只读观察面、系统日志检索与系统级人员树的唯一 owner。

## 职责

- **Observer 聚合面**：`src/server/services/observer/observer-service.ts` 的 `ObserverService` 维护「kind → Provider」注册表，`tree(kind)` / `list(kind)` 在请求时现场收集并组装；未注册 kind 抛 `ObserverKindNotFoundError`（路由映射 404），`register` / `unregister` 可独立摘除 Provider 回滚。
- **acp-link Provider**：`providers/acp-link.ts` 只读遍历 acp-ws 连接、external-relay 条目与 chat-relay 客户端三类来源，按 source 归一化 `linkId`（`acp-ws:*` / `external-relay:*` / `chat-relay:*`）。join key 经 environment 权威表回查，对齐失败（env 缺失、machineId 未注册、归属不一致）记 `verified=false` 并进 `integrity.mismatchedItems`；machine 连接的 `__machine__` 哨兵 userId 不外显。
- **关系树组装**：`relation-tree.ts` 是纯函数（无 IO、无副作用），产出 `byOrg`（org → user → agent → instance；无 instance 归属的叶子挂 `AgentNodeView.leaves`）、`byEntity`（按 machineId 分组）与完整性汇总，逐层排序保证输出可断言。
- **名称解析**：`names` 字典按角色现场解析——组织与用户经 `IdentityDirectory`、agentConfig 经 agent-config、machine 经 machine、instance 经 `agentInstanceRepo`；缺失 id 不占位（前端回退显示原始 id），结果即用即弃、不缓存。
- **系统日志**：`system-log-service.ts` 列举日志根目录直属 `.log` 文件、按关键字与 error 条件过滤检索（单文件上限 50 MiB，只保留最近 limit 条）、流式下载。文件名先过 `LOG_FILE_PATTERN`（拒绝 `/`、`\`、NUL）再 `lstat` 要求普通文件，目录与 symlink 一律拒绝。
- **系统人员树**：`system-people-tree-service.ts` 合并 `IdentityDirectory.listOrganizationsWithMembers()` 与 `agent_config` 表；用户集合取组织成员与 agent owner 的并集，缺 member 行的 owner 仍出现在树上（role 为 null），展示信息一次批量补齐、不在循环里逐行查询。
- **HTTP 交付物**：`/api/system/observer/acp-link`、`/api/system/logs`（`/`、`/search`、`/download`）、`/api/system/people-tree`；三者均 `systemApiKeyAuth: true`，响应 `{ success, data }` 骨架，错误不泄内部细节。

## 依赖边界

本包属 `resources` 类别，依赖矩阵（`scripts/lib/architecture-boundary-rules.ts`）禁止 `resources → platform-impl`：不导入 `@fenix/identity/*` 与 `@fenix/access-control/*`，身份数据只经 `IdentityDirectory` 窄契约取得。`fenix.module.ts` 的 `dependsOn` 只表达服务端装配依赖，每条都有 `src/**` 值导入证据：

- `agent-config`：`observer-service.ts` 用 `getAgentConfigById` 完成 machine 解析链 `environment.agentConfigId → agentConfig.machineId`，用 `findAgentConfigNamesByIds` 填名称字典。
- `machine`：同一文件用 `findMachineNamesByIds` 解析 machineId 角色名称；缺名只影响展示，不影响采集。
- `agent-runtime` 同为值导入（连接快照、`environmentRepo` / `agentInstanceRepo`、延迟加载的 `getChatChannelController`），但它是 profile 固定启用的基础模块，不进资源模块的装配依赖校验范围。
- `resource-sandbox` 只在 `web/**` 被引用（`MasterKeyGate`、`mergeFlatRows` 等控制台组件）：web 贡献不进服务端装配顺序，其启用由 profile 的 `web` 列表表达，写进 `dependsOn` 等于凭空声明一条服务端不具备的边。

## 守卫由宿主注入

`systemApiAuthPlugin` **不是**本包的导出。三个路由文件直接 `import { systemApiAuthPlugin } from "@server/plugins/system-api-auth"`，在模块加载期 `new Elysia({ name, prefix })` 并 `export default app`；宿主因此只能按默认导出挂载（`apps/server/src/main.ts` 的 `.use(apiSystemLogsRoutes)`），而不是 sandbox 那种工厂注入形态（`.use(createApiSandboxRoutes({ systemApiGuardPlugin: systemApiAuthPlugin }))`）。

直接 import 宿主实例的两点后果：包不能脱离宿主的 `@server` 别名被消费；Elysia 的 `macro` / `state` 是实例作用域的，唯一性如今靠「引用的就是宿主那一份」来维持——同名的第二份实例会被 Elysia 按 plugin `name` 去重，先构造者静默生效。目标形态是「工厂 + 守卫注入」（W2 切片），宿主侧的 `.use(...)` 调用点须同批改为传参。

包内测试的替换接缝（不改模块图）：`setObserverServiceDeps()`（部分覆盖采集依赖，传 `null` 恢复默认）、`setSystemLogServiceForTests()`、`setSystemPeopleTreeServiceForTests()`。

## 配置与 DB

- **不读 `process.env`**：日志根目录由 `createSystemLogService(logRoot)` 传入，默认 `resolve(process.cwd(), "logs")`——「进程工作目录」是唯一的环境感知点，且只在调用时求值。
- **没有 repository 层**：`system-people-tree-service.ts` 直接经 `@server/db` 取宿主 DB 句柄并读 `@server/db/schema` 的 `agentConfig` 表。这是 §1.7 表定义迁出与 W2 边界切断的残留，不是可扩散的写法。
- 身份数据走 `getIdentityDirectory()`（`@fenix/platform-sdk/server`）的只读投影，本包不持有身份表；手机号等字段按目录契约缺失时为 `null`。
- Observer 链路零持久化：不挂生命周期事件、不缓存、不写库，输出即用即弃。
- web 层的 master key 存 sessionStorage（键 `rcs_admin_master_key`），请求时经 `request.ts` 的 `bearerToken` 注入 `Authorization` 头，401 由页面清 key 回门；密钥不进日志。

## 边界外的已知项

- **没有浏览器出口**：`package.json` 只有 `.` 与 `./server`，且 `src/index.ts` 是空占位；`web/` 没有 `index.ts`，`./web` 与 `./web/i18n` 未登记。宿主因此按 vite 别名逐文件指向包内路径（`@/src/api/observer`、`@/src/pages/admin/AdminObserverPage` 等），i18n JSON 由 `apps/web/src/i18n/index.ts` 相对深链导入。补出口归 W2 切片，别名收敛归 §1.6。
- **路由仍是 default export**：工厂化 + 守卫注入归 W2（见上节）。
- **没有 `src/module.ts` 单例**：`fenix.module.ts` 暂不声明 `create`；`observerService` / `systemLogService` / `systemPeopleTreeService` 目前是各自模块内的进程级单例，组合根归 W2。
- **`@server/*` 仍是生产代码依赖**：`src/**` 有 9 处导入 / 7 文件（守卫插件、`@server/db`、`@server/db/schema`、`@server/config`、`@server/types/store`）。其中表定义迁出归 §1.7；整条边是台账 `apps-boundary` 条目（owner 1.5，须消除而非编码成装配依赖）。
- **web 面依赖未声明**：`web/**` 使用 `react` / `react-i18next` / `ahooks` / `lucide-react` / `sonner` 与宿主 `@/components/ui`，`package.json` 未声明这些；`@fenix/web-runtime` 已声明但尚无消费方（T2g 的 admin-key 落点）。接入归 W2。
- **master key helper 仍在宿主**：唯一实现将迁 `@fenix/web-runtime/web/lib/admin-key.ts`（T2g，存储键逐字不变），本包 6 处引用届时改指。
- **未声明 `contributions` / `web` / `envDefinitions`**：消费方分别是 §1.5 宿主挂载、§1.6 WebShell 装配与 §1.7 preflight，形状须与消费端同时定型。
- **包内测试仍导入宿主内部路径**（`@server/test-utils/observer-fixtures`、`@server/test-utils/stubs/module-stubs`、`@server/plugins/auth`）：逐包 `/server/testing` 的边界归 W2。
