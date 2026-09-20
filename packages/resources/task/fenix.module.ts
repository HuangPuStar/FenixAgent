import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * Task 资源模块描述符。
 *
 * 定时任务与执行日志的唯一 owner：任务的 CRUD 领域校验（cron 语义、IANA 时区、超时与 type 不可变）、
 * 进程内调度（`node-schedule` job + running 单飞标记）以及 HTTP / Agent 两类执行器的执行结果落库。
 * 服务端交付物集中在 `@fenix/resource-task/server`（`src/server.ts`）：`SchedulerService` 与进程级单例
 * `schedulerService`（宿主 `apps/server/src/main.ts` 在生命周期里 `start()` / `stop()`）、任务领域服务、
 * 两个仓储单例（`scheduledTaskV2Repo` / `taskExecutionLogRepo`）、`toInvocationDate`，以及 default export
 * 的路由实例 `webTasksV2Routes`——宿主 `apps/server/src/routes/web/index.ts` 以 `.use()` 挂载到 `/web/tasks/v2`。
 * 装配面上的消费者目前只有宿主 `apps/server`。
 *
 * `dependsOn: []`：本包服务端生产代码（`src/**`，排除 `__tests__`）没有任何指向已注册资源模块的值导入。
 * 唯一的 workspace 值导入是 `src/server/services/scheduler/agent-executor.ts` 的
 * `@fenix/agent-runtime/server`（`openAgentSession`、`PromptTurn`）：agent-runtime 是 profile 的固定基础
 * 槽位（registry 的 `requireFoundation` 总是启用），不属于「资源模块之间必须成套启用」的装配依赖；
 * 生成器的 `assertDependsOnComplete` 同样只对 `kind: "resource"` 的目标包生效，写进来只会给 profile
 * 增加一条恒真的边，不产生任何保护。其余导入全部落在宿主应用内部、不是模块边，已由台账 `apps-boundary`
 * 登记（owner 1.5；其中表定义迁出归 §1.7）：`src/server/repositories/task-v2.ts` 与
 * `src/server/repositories/task.ts` 的 `@server/db` + `@server/db/schema`（`scheduled_task_v2` /
 * `task_execution_log` 表定义）、`src/server/routes/web/tasks-v2.ts` 的 `@server/plugins/auth`。
 * `package.json` 也未声明任何 `@fenix/resource-*` 编译依赖，写入依赖项会直接触发
 * `assertDependsOnDeclared` 的「未声明编译依赖」失败。
 *
 * 不声明别的反向边：本包当前没有来自其它模块的入边——只有宿主 `apps/server` 引用它（入口与生命周期
 * 取 `schedulerService`，路由聚合取 `webTasksV2Routes`）。宿主是装配者而不是模块，`host → package` 的
 * 方向由 `.use()` 与生命周期调用显式持有；`apps/web` 侧对组件与 i18n 资源的消费同理只进 WebShell 装配，
 * 不参与服务端装配顺序，都不能也不该编码成本模块的 `dependsOn`。
 *
 * 不声明 `create`：模块组合根（`src/module.ts` 的进程级单例）属任务 1.3 W2 切片，当前装配由宿主显式调起，
 * 提前造工厂会留下第二套装配路径。不声明 `contributions` 与 `web`：两者的消费方分别是 §1.5 的宿主挂载
 * 与 §1.6 的 WebShell 装配，形状必须与消费端同时定型；本包也还没有 `web/index.ts` 浏览器出口。
 * 不声明 `envDefinitions`（归 §1.7）：本包不读 `process.env`、不读 `@server/config`，宿主用
 * `RCS_DISABLE_SCHEDULER` 决定是否调用 `schedulerService.start()`，该变量的声明与校验在宿主。
 */
export const moduleManifest = {
  id: "task",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.task"],
} satisfies ModuleManifest;
