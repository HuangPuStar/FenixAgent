# @fenix/resource-task

定时任务（HTTP / Agent 两类执行）与执行日志的唯一 owner。

## 职责

- **进程内调度**：`src/server/services/scheduler/index.ts` 的 `SchedulerService` 用 `node-schedule` 按 task id 维护 job。`start()` 读 `scheduledTaskV2Repo.listEnabled()` 逐个装载（非法 cron 只记日志不阻断启动），成功装载后把 `job.nextInvocation()` 经 `toInvocationDate` 写回 `nextRunAt`；`stop()` / `unschedule()` 取消 job 并清 running 标记；单例 `schedulerService` 由宿主在生命周期里 `start()` / `stop()`。
- **单飞与执行日志**：`execute(taskId, "cron" | "manual")` 以 `runningTasks` 去重——重复触发写一条 `skipped` 日志（`skipReason: previous_run_still_active`）并返回 failed，不排队；任务已删除或已禁用时清理残留 job（否则该任务会被永久误判为 running）；执行结果统一写 `taskExecutionLog` 并更新 `lastRunAt` / `lastStatus`。
- **执行器契约**：`TaskExecutor` 由 `register()` 注册，内置 `http`（默认 POST、无 `content-type` 时补 JSON、GET 不发 body、`AbortSignal.timeout(timeoutSeconds ?? 30)`、摘要截断 2000）与 `agent`（`openAgentSession({ startSource: "scheduled" })`，累积 `session/update` 中 `update.sessionUpdate === "agent_message_chunk"` 的 `content.text`，遇 `result.stopReason` 结束，超时归 `timeout`，`finally` 必定 `turn.dispose()`；`setAgentExecutorDeps()` 是测试接缝）。
- **领域服务**：`src/server/services/task-v2.ts` 做用户 + 组织双重隔离的 CRUD、toggle、manual trigger 与日志分页 / 清空；跨字段校验覆盖 cron 5 字段 + 字符合集 + `cron-parser` 语义、IANA 时区、超时 1–3600、agent 任务必填 agentId、HTTP URL 与 headers 形状；更新路径拒绝改 type、拒绝给 HTTP 任务写 agentId、拒绝空串 cron；cron / 时区 / enabled 变化才 reschedule。响应把时间戳降为 epoch 秒、可空字段归一为 `null`。
- **持久化**：`src/server/repositories/task-v2.ts`（`scheduledTaskV2Repo`：分页列表带 keyword / type / agentId 过滤与真实 total、`getByUserAndOrgAndId` 归属谓词、`listEnabled`）与 `src/server/repositories/task.ts`（`taskExecutionLogRepo`）是唯一数据访问点。
- **HTTP 交付物**：`src/server/routes/web/tasks-v2.ts` 的 `/web/tasks/v2` 系列（列表 / 创建 / 详情 / 更新 / 删除 / toggle / trigger / 日志查询 / 日志清空），model 定义在 `src/server/schemas/task-v2.schema.ts`，信封用 `@fenix/platform-sdk` 的 `WebOkSchema` / `WebErrSchema` / `PaginationParamsSchema`；`safeTaskOp` 把 Postgres `invalid input syntax` 归一为 404。
- **浏览器侧**：`web/api/tasks-v2.ts`（`taskV2Api`，经 `@/src/api/request`）、`web/pages/agent-panel/`（`AgentTasksPage` 页面 + `TasksPanel` / `AgentTasksRegistry` / `AgentTaskRuntimeBoard` / `TaskForm` / `TaskLogDialog` / `CronEditor` 与 `agent-tasks-utils`）、`web/i18n/{zh,en}/tasks-v2.json`（各 20 键）。
- **测试**：`src/__tests__`（10 文件）覆盖校验与更新不变量、路由未认证 401 与跨组织拒绝、调度器残留 job 清理、http / agent 执行器与超时分类；`web/__tests__`（5 文件）覆盖 CronEditor 纯逻辑与组件、`agent-tasks-utils`。

## 依赖边界

本包属 `resources` 类别，类别禁则只有一条（`scripts/lib/architecture-boundary-rules.ts`）：`resources → platform-impl`。

- **不导入** `@fenix/identity/*` 与 `@fenix/access-control/*`；组织与用户上下文只从路由注入的 `store.authContext` 取用，不做角色解释。
- **跨包值导入**只有三个包：`@fenix/agent-runtime/server`（agent 执行器的非阻塞入口）、`@fenix/logger`、`@fenix/platform-sdk`（schema 基元）。没有任何指向其它资源包的值导入，故 `dependsOn` 为空——本包是叶子模块，装配上不要求其它资源模块同批启用。
- **`@server/**` 是待消除的宿主内引用**：`@server/db`、`@server/db/schema`（`scheduled_task_v2` / `task_execution_log`）、`@server/plugins/auth`；已由台账登记为 `apps-boundary`（owner 1.5，其中表定义迁出归 §1.7）。

## 守卫由宿主注入

Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填，因此 `authGuardPlugin` 必须与宿主的认证解析（含 `setTestAuth` 测试 seam 与组织上下文）是同一份实例；包内不得自带一份同名守卫——两份同名实例会被 Elysia 按 plugin `name` 去重，先构造的一方静默生效。

目标形态与沙盒样本一致：路由以**工厂**导出（`createWebTasksV2Routes({ authGuardPlugin })`），由宿主注入守卫。**现状尚未到达**：本文件仍是 default export 的 `new Elysia({ name: "web-tasks-v2" }).use(authGuardPlugin)`，守卫直接来自 `@server/plugins/auth`，用 `sessionAuth: true` 宏 + `store.authContext` 取 `userId` / `organizationId`；切到工厂形态归任务 1.3 W2 切片（见下节）。「路由 + 真实守卫 + 会话」这条已发布合同由宿主用例覆盖，包内不重复断言。

## 配置与 DB

本包不读 `process.env`、不读 `@server/config`：

- 唯一的启动开关 `RCS_DISABLE_SCHEDULER` 由宿主读取，宿主据此决定是否调用 `schedulerService.start()`；
- DB 句柄直接取宿主 `@server/db`（模块作用域单例），表定义取 `@server/db/schema`。W2 改为平台 `getDatabase()`，且句柄读取必须发生在调用时——模块加载期宿主可能尚未完成基础设施初始化；
- `src/server/repositories/**` 是唯一数据访问点，`routes` 与 `services` 不直接取 DB 句柄或表对象。

`envDefinitions` 与表定义迁出收敛在任务 1.7 处理。

## 边界外的已知项

- **没有 `web/index.ts` 浏览器出口**：宿主的 `apps/web/src/i18n/index.ts` 用相对路径直接导入本包 `web/i18n/*/tasks-v2.json`，页面文件也被宿主编译期相对导入；`web/api/**` 与页面仍用宿主别名 `@/src`、`@/components`（55 处 / 9 文件，台账 `web-package-not-to-app`，owner 1.6）。`./web` 与 `web/i18n/index.ts` 出口归 W2 切片 / §1.6 WebShell 装配。
- **路由仍是 default export 而非「工厂 + 守卫注入」**：改法见 §6.4 W2 配方（`deps` 类型落包内 `src/routes/dependencies.ts`，只声明 `AnyElysia`）；对应的 `@server/plugins/auth` 引用同批消失。
- **没有 `src/module.ts` 单例**：manifest 因此不声明 `create`；进程级组合根（`schedulerService` 等单例的装配出口）归 W2 切片。
- **表定义仍导入 `@server/db/schema`**：迁出归 §1.7；`@server/db` 句柄改 `getDatabase()` 归 W2；台账 `apps-boundary` 条目保留至两件事都完成。
- **包内测试仍引用 `@server/*`**（4 文件）：3 个用例取 `@server/db/schema` 的行类型，`round55-tasks-v2-routes.test.ts` 另取 `@server/plugins/auth` 与 `@server/test-utils/stubs/module-stubs`；改指平台 `/testing` 与包内守卫替身归 W2（§6.2 映射表）。
- **`manifest.web` 未声明**（归 §1.6 / §1.5 共同定型）；**`envDefinitions` 未声明**（归 §1.7）。
- **两个纯逻辑测试复制了实现而非导入**（`toInvocationDate` 的类型守卫、http-executor 的超时分类）：实现漂移不会被它们发现，收敛（导出可测符号或改为注入）归 W2。
