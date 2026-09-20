import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * Task 资源模块描述符。
 *
 * 定时任务与执行日志的唯一 owner：任务的 CRUD 领域校验（cron 语义、IANA 时区、超时与 type 不可变）、
 * 进程内调度（`node-schedule` job + running 单飞标记）以及 HTTP / Agent 两类执行器的执行结果落库。
 * 服务端交付物集中在 `@fenix/resource-task/server`（`src/server.ts`）：组合根 `createTaskModule()`
 * （进程级单例：调度器与两个仓储）、路由工厂 `createWebTasksV2Routes(deps)`、任务领域服务、仓储单例
 * （`scheduledTaskV2Repo` / `taskExecutionLogRepo`）与 `toInvocationDate`——宿主
 * `apps/server/src/routes/web/index.ts` 以 `createWebTasksV2Routes({ authGuardPlugin })` 挂载到
 * `/web/tasks/v2`。浏览器交付物是
 * `@fenix/resource-task/web`（`web/index.ts`：任务页面、api client 与 `tasksV2` i18n 资源，宿主
 * `apps/web` 消费）。装配面上的消费者目前只有宿主 `apps/server` 与 `apps/web`。
 *
 * `dependsOn: []`：本包服务端生产代码（`src/**`，排除 `__tests__`）没有任何指向已注册资源模块的值导入。
 * 唯一的 workspace 值导入是 `src/server/services/scheduler/agent-executor.ts` 的
 * `@fenix/agent-runtime/runtime`（`getBoundAgentRuntime()` 与 `AgentRuntimePort["openAgentSession"]`、
 * `PromptTurn`；1.4 W6b 之前写的是 `@fenix/agent-runtime/server`，"生产从装配面取会话能力" 的记载
 * 已与代码不符）：agent-runtime 是 profile 的固定基础
 * 槽位（registry 的 `requireFoundation` 总是启用），不属于「资源模块之间必须成套启用」的装配依赖；
 * 生成器的 `assertDependsOnComplete` 同样只对 `kind: "resource"` 的目标包生效，写进来只会给 profile
 * 增加一条恒真的边，不产生任何保护。
 *
 * 另一个方向的残留只剩表定义：`src/server/repositories/task-v2.ts` 与 `task.ts` 仍 import
 * `@server/db/schema`（`scheduled_task_v2` / `task_execution_log` 表定义，共 6 处导入，迁出归 §1.7）——
 * 对应 `apps-boundary` 台账条目保留至该步骤完成，其 owner 与 rationale 已为「1.7 / 仅剩表定义导入」
 * （`scripts/architecture/exceptions.json`；该文件属计划 §4 的 W3 独占写入范围，包切片只读不改）。
 * W2 已切断另外两条宿主内部依赖：路由不再
 * `.use()` 宿主的 `authGuardPlugin`（改为工厂注入，`src/server/routes/dependencies.ts` 只声明
 * `AnyElysia`），仓储不再 import 宿主的 `db`（改为调用时 `getTaskDatabase()` →
 * `@fenix/platform-sdk/server` 的 `getDatabase()`）。
 *
 * `web/` 的跨包值导入（`@fenix/agent-config/web`、`@fenix/ui-components`、`@fenix/web-runtime`）不产生装配边：
 * `assertDependsOnComplete` 只扫描 `src/**`，web 贡献依赖谁由 profile 的 `web` 列表表达；方向符合 §2.3
 * 依赖矩阵（资源包 web 面可消费兄弟资源包的 `./web` 公开出口与共享基础设施包）。
 *
 * `create` 声明组合根（任务 1.3 W2 落地）：返回包内既有单例而不是新建一套——`schedulerService` 持有
 * 进程内的 job 表与 running 标记，同一份 DB 记录只允许有一个调度 owner，再构造一个实例等于给同一批任务
 * 开两条调度路径（重复执行、重复写执行日志）。工厂保持惰性：registry 会被大量位置导入，不能在索引层
 * 就把 Drizzle、Elysia 与 node-schedule 拖进模块图。
 *
 * 不声明 `contributions` 与 `web`：两者的消费方分别是 §1.5 的宿主挂载与 §1.6 的 WebShell 装配，
 * 形状必须与消费端同时定型；单方面发明会返工。不声明 `envDefinitions`（归 §1.7）：本包不读
 * `process.env`、不读 `@server/config`，宿主用 `RCS_DISABLE_SCHEDULER` 决定是否调用
 * `schedulerService.start()`，该变量的声明与校验在宿主。
 */
export const moduleManifest = {
  id: "task",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.task"],
  // 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Drizzle、Elysia 与 node-schedule 拖进模块图。
  create: () => import("./src/module").then((module) => module.createTaskModule()),
} satisfies ModuleManifest;
