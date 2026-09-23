# @fenix/resource-task

定时任务（HTTP / Agent 两类执行）、执行日志与进程内调度的唯一 owner。

「唯一」按命令核对：`git grep -ln node-schedule -- packages apps/server/src` 命中 6 个文件、全部在本包
（`README.md` / `package.json` / `fenix.module.ts` + 2 个源码文件 + 1 个测试文件；其中真正 import 的只有
`src/server/services/scheduler/index.ts`，`scheduler/utils.ts` 与 `src/__tests__/task-v2-validation.test.ts`
只在注释里提到），宿主 `apps/server/src` 为 0，`/web/tasks/v2` 系列路由与 `scheduled_task_v2` /
`task_execution_log` 的读写也只在包内（表定义亦归本包 `db/schema.ts`，§1.7 B12 起）。

## 职责

- **进程内调度**：`src/server/services/scheduler/index.ts` 的 `SchedulerService` 用 `node-schedule` 按 task id
  维护 job。`start()` 读 `scheduledTaskV2Repo.listEnabled()` 逐个装载（非法 cron 只记日志、不阻断启动），
  成功装载后把 `job.nextInvocation()` 经 `toInvocationDate` 写回 `nextRunAt`；`stop()` / `unschedule()`
  取消 job 并清 running 标记；生产代码只通过单例 `schedulerService` 使用它，`start()` / `stop()` 由宿主
  生命周期调用（`apps/server/src/main.ts:112,320`，是否启动由宿主读 `RCS_DISABLE_SCHEDULER` 决定）。
- **单飞与执行日志**：`execute(taskId, "cron" | "manual")` 以 running 标记去重——重复触发写一条 `skipped`
  日志（`skipReason: previous_run_still_active`）并返回 failed，不排队；任务已删除或已禁用时清理残留 job
  （否则该任务会被永久误判为 running）；执行结果统一写 `taskExecutionLog` 并更新 `lastRunAt` / `lastStatus`。
- **执行器契约**：`TaskExecutor` 由 `register()` 注册，内置 `http`（默认 POST、无 `content-type` 时补 JSON、
  GET 不发 body、`AbortSignal.timeout(timeoutSeconds ?? 30)`、摘要截断 2000，超时判定用
  `isTimeoutAbortError`）与 `agent`（`openAgentSession({ startSource: "scheduled" })`，累积
  `session/update` 中 `update.sessionUpdate === "agent_message_chunk"` 的文本，遇 `result.stopReason`
  结束，超时归 `timeout`，`finally` 必定 `turn.dispose()`）。
- **领域服务**：`src/server/services/task-v2.ts` 做用户 + 组织双重隔离的 CRUD、toggle、手动触发与日志分页 /
  清空；跨字段校验覆盖 cron 5 字段 + 字符合集 + `cron-parser` 语义、IANA 时区、超时 1–3600、agent 任务必填
  agentId、HTTP URL 与 headers 形状；更新路径拒绝改 type、拒绝给 HTTP 任务写 agentId、拒绝空串 cron；
  cron / 时区 / enabled 变化才 reschedule。响应把时间戳降为 epoch 秒、可空字段归一为 `null`。
- **持久化**：`src/server/repositories/task-v2.ts`（`scheduledTaskV2Repo`：分页列表带 keyword / type /
  agentId 过滤与真实 total、`getByUserAndOrgAndId` 归属谓词、`listEnabled`）与
  `src/server/repositories/task.ts`（`taskExecutionLogRepo`）是唯一数据访问点——包内 `getTaskDatabase()`
  的调用点全部落在这两个文件：`git grep -n "getTaskDatabase()" -- packages/resources/task/src` 命中
  15 处（`task-v2.ts` 8 + `task.ts` 7）。调用点之外只有 2 条 import 与 1 处注释提及，函数自身的定义在
  `src/server/db.ts`——按裸名字 grep 会把这几类一并计入（`git grep -n "getTaskDatabase" --
  packages/resources/task/src` = 17 行 = 调用 15 + import 2；后两个文件尚未纳入索引，加上定义与
  `src/__tests__/db-stub.ts` 的注释，工作树口径为 19 行），因此本行按带括号的调用口径核对。句柄经
  `src/server/db.ts` 在**每次调用时**取（模块加载期宿主可能尚未完成基础设施初始化）。
- **HTTP 交付物**：`createWebTasksV2Routes(deps)`（`src/server/routes/web/tasks-v2.ts`）声明 `/web/tasks/v2`
  系列（列表 / 创建 / 详情 / 更新 / 删除 / toggle / trigger / 日志查询 / 日志清空），model 定义在
  `src/server/schemas/task-v2.schema.ts`，信封用 `@fenix/platform-sdk` 的 `WebOkSchema` / `WebErrSchema` /
  `PaginationParamsSchema`；`safeTaskOp` 把 Postgres `invalid input syntax` 归一为 404。宿主挂载点是
  `apps/server/src/routes/web/index.ts:17,52,79`（已按工厂形态接线，见「守卫由宿主注入」）。
- **组合根**：`src/module.ts` 的 `createTaskModule()` 返回包内既有单例（`schedulerService` + 两个仓储）；
  `fenix.module.ts` 的 `create` 惰性指向它。服务端出口是 `src/server.ts`（`exports["./server"]`）；表定义出口是
  `db/schema.ts`（`exports["./db"]`，§1.7 B12 起：`scheduledTaskV2` / `taskExecutionLog` 与
  `ScheduledTaskV2Row` / `ScheduledTaskV2Insert`）。
- **浏览器侧**：`web/index.ts`（`exports["./web"]`）导出 `AgentTasksPage`、`TasksPanel`、`taskV2Api` 与 i18n
  资源；页面在 `web/pages/agent-panel/**`，api client 在 `web/api/tasks-v2.ts`。命名空间 `tasksV2` 的 123
  个键（en / zh 逐键对齐，`web/__tests__/task-i18n.test.ts` 守护）由本包自持，其中 6 个
  `panelMode.tasks*` 是 W2 从宿主 `components.json` 迁入的面板文案；`loadState.*`（4 键）与
  `action.more` 是 §1.3(6) 状态补齐时新增的文案。
- **列表状态口径（§1.3(6)，2026-09-20 补齐）**：任务列表与侧栏面板的加载失败都落在**持久**错误分支
  （`role="alert"` + 重试入口接到 `useRequest().refresh`），不再只弹 toast 后退回「暂无任务」空态；
  401/403 单列无权限分支且不给重试（`web/pages/agent-panel/pages/agent-tasks-utils.ts` 的
  `isUnauthorizedError` 同时认宿主 `forbidden` 与 request 层归一的 `UNAUTHORIZED`）；加载态带
  `aria-busy`；`TasksPanel` 的行选择区改为真 `<button aria-pressed>`，不再用 `role="button"` 容器
  包住 `Switch`/`Button`，纯图标控件（执行 / 更多操作 / 开关）全部有 `aria-label`。
  为什么列表取数必须经 `unwrap`：ahooks 只在 promise reject 时置 `error`，读 `data.success` 的写法会让
  失败静默变成空数组——这正是缺口成因，改动前的 `TasksPanel` 就属此类。
- **测试**：`bun test packages/resources/task` 覆盖 19 个文件，含包边界契约测试
  （`src/__tests__/task-source-migration.test.ts`，逐条对应计划 §1 的静态条件）、浏览器面守卫
  （`web/__tests__/task-browser-surface.test.ts`，走值导入图 + 外部白名单）与列表状态用例
  （`web/__tests__/task-list-states.test.tsx`，真实渲染）；最近一次全绿为
  321 pass / 0 fail / 519 expect（2026-09-22，§1.7 B12 收尾；此前的「320 pass / 511 expect（2026-09-20）」
  在 B12 改动前实测已为 321 pass / 516 expect，属过期数字，已订正）。若整批用例同时报 `Cannot find module`，先确认是否有
  并行包正处于迁移中间态：`bunfig.toml` 的仓库共享 preload（`apps/server/src/test-utils/setup-mocks.ts`）
  会把它拉进每个用例文件，与本包改动无关。
  浏览器面守卫的两条「可构建性」断言（宿主别名 / 外部依赖白名单）只对本包与共享基础设施包
  （`packages/ui-components`、`packages/web-runtime`）的文件生效——范围由 `POLICED_DIRECTORIES` 显式列出，
  理由与实测见「边界外的已知项」；ui-components 新引入的库（`recharts`、`streamdown` 与若干 radix 原语）
  落在白名单内，白名单缺项会让本包守卫变红以强制一次浏览器可用性评审。

## 依赖边界

本包属 `resources` 类别，类别禁则只有一条（`scripts/lib/architecture-boundary-rules.ts`）：
`resources → platform-impl`。实测 `git grep -nE 'from "@fenix/(identity|access-control)' --
packages/resources/task/src packages/resources/task/web` 为 0（按 import 形态而不是裸包名核对：裸名会把本
README 与守卫注释里「identity 是上游迁移中间态」的说明文字也算成依赖）：组织与用户上下文只从路由注入的
`store.authContext` 取用，不做角色解释。**`db/schema.ts` 是唯一的例外，且不是调用期依赖**：B12 迁入的
`scheduled_task_v2.user_id` 外键列对象来自 `@fenix/identity/db`（Drizzle 的 `.references()` 只接受列对象、
没有字符串名），属 §6.1 的**跨模块外键 schema 组装期例外**——检查器按 `packages/**/db/**` 路径整体放行
（`scripts/lib/architecture-boundary-rules.ts` 的 `isSchemaAssemblyPath`），`special-dependency` 与
`apps-boundary` 都不对它判定；同口径见 agent-config / knowledge / memory 的 `db/schema.ts`。

- **跨包值导入 26 条说明符、6 个目标包**（`grep -rhoE '"@fenix/[^"]+"' packages/resources/task/src
  packages/resources/task/web | grep -v resource-task | sort -u | wc -l` → 26；未过滤时 27 条，多出的一条是
  `web/index.ts` 注释里的自重引用。目标包为 `@fenix/agent-config`、`@fenix/agent-runtime`、`@fenix/logger`、
  `@fenix/platform-sdk`、`@fenix/ui-components`、`@fenix/web-runtime`，含后三者的子路径）。每条都落在对方
  `package.json` 声明的公开出口（`./server`、`./web`、`./testing` 与逐文件子路径），零 `@fenix/*/src/**`——
  由契约测试同时按「不深入 src」与「能解析到对方 exports 键」两条断言守护。
- **`dependsOn: []`**：本包服务端生产代码没有任何指向已注册资源模块的值导入；唯一的 workspace 值导入是
  agent 执行器的 `@fenix/agent-runtime/server`，而 agent-runtime 是 profile 的固定基础槽位（生成器
  `assertDependsOnComplete` 也只对 `kind: "resource"` 目标生效）。理由与反例写在 `fenix.module.ts`。
- **宿主内部导入已归零（§1.7 B12）**：`scheduled_task_v2` / `task_execution_log` 两张表的定义迁入本包
  `db/schema.ts`（出口 `./db`），原先 6 处 `@server/db/schema`（生产 3 条：`repositories/task-v2.ts` 2 条 +
  `repositories/task.ts` 1 条；包内测试 3 条 `import type`）同批改指本包出口——仓储经该出口**自我引用**
  （`db/` 不在本包 `tsconfig.json` 的 `include` 里，走出口与外部消费方同一条解析路径）。复核命令：
  `git grep -nE "from \"@server/" -- packages/resources/task` → 仅 1 行命中，是 `src/server/db.ts` 注释里
  点名的旧写法示例（`import { db } from "@server/db"`），不是可解析导入；可解析导入 **0 处**，
  契约测试（条件 1）与台账（`apps-boundary @fenix/resource-task`）
  同批由「白名单放行一条残留」改为「零例外 / 条目删除」。
  W2 已切断另外两条宿主内部依赖：`@server/plugins/auth`（改工厂注入）与 `@server/db`（改 `getDatabase()`）。
- **零宿主别名与零环境变量**：包内 `web/` 的 `@/` **import 说明符** 0 处（`git grep -nE "from \"@/"
  -- packages/resources/task/web` 为 0）、`src/` 的 `process.env` 0 处、穿透到包外的相对引用 0 处，均由
  契约测试守护（对应计划 §1 条件 2 / 4 / 3）；`mock.module()` 的实参不是 import 说明符、上面这条 grep 与
  浏览器面守卫都看不见它，因此契约测试另有一条按全包扫描其说明符的用例（W2.5 补，堵的是残留死 mock）。

## 守卫由宿主注入

路由以工厂形式导出：`createWebTasksV2Routes({ authGuardPlugin })`，注入类型只声明 `AnyElysia`
（`src/server/routes/dependencies.ts`），包内不 import 宿主的 `@server/plugins/auth`。

为什么必须注入而不是包内自带一份：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例
回填；且插件按 `name` 去重，两份同名守卫会被静默择一，症状是「认证解析在宿主、路由看到的上下文却是空的」。
宿主的认证解析还要兼顾测试 seam（`setTestAuth`）与组织上下文，因此守卫必须与宿主是同一份实例。

**覆盖边界（实测）**：本包路由用例注入的是替身（`src/__tests__/guard-stubs.ts`），因此包内证明的是「路由
确实声明了 `sessionAuth: true`、未认证时在触达仓储前返回 401、已认证时把上下文转发给服务层」；真实守卫的
凭据解析与 401 映射由宿主用例覆盖（`apps/server/src/__tests__/round45-auth-plugin.test.ts`）。

**宿主接线（2026-09-20 实测）**：服务端已按工厂形态接线——`apps/server/src/routes/web/index.ts:17` 从
`@fenix/resource-task/server` 取 `createWebTasksV2Routes`、`:52` 注入 `authGuardPlugin` 构造、`:79` 挂载；
调度器同理：`apps/server/src/main.ts:112` 取 `schedulerService`，`:354-358` 按 `RCS_DISABLE_SCHEDULER`
决定启动、`:555` 停止。宿主 `apps/web` 侧与 i18n 相关的两处（子路径注册、`NS` 常量）也已落地，剩 3 处
直连（见「边界外的已知项」）。

## 配置与 DB

本包不读 `process.env`、不读 `@server/config`（`git grep -n "process.env" -- packages/resources/task/src`
为 0）：

- 唯一的启动开关 `RCS_DISABLE_SCHEDULER` 由宿主声明与读取（`apps/server/src/env.ts:83`、
  `main.ts:354-358` 经 `bootstrap/scheduler-startup.ts` 决定是否调用 `schedulerService.start()`，
  `main.ts:555` 停止）；本包只提供 `start()` / `stop()`。
- DB 句柄经 `src/server/db.ts` 的 `getTaskDatabase()` → `@fenix/platform-sdk/server` 的 `getDatabase()`
  在调用时获取；表对象自 §1.7 B12 起来自本包出口 `@fenix/resource-task/db`（`src/server/repositories/**`
  的唯一取表来源）。
- `src/server/repositories/**` 是唯一数据访问点，`routes` 与 `services` 既不取 DB 句柄也不直接操作表。
- 测试基建：`src/__tests__/db-stub.ts` 用转发代理把每次属性读取转发到当前 DB 替身，从而在
  `initializeTestApplicationInfrastructure()` 已注入句柄之后，用例仍可随时 `stubDb(...)` 更换替身
  （基础设施持有的是引用，不解这一层会让「用例内换替身」静默失效）。

`envDefinitions` 未声明：归任务 1.7，本包不含环境变量声明。

## 边界外的已知项

- **`TasksPanel` 的 trigger / toggle 无失败反馈、也无成功 toast（只登记，本任务不实现）**：
  现象：`web/pages/agent-panel/TasksPanel.tsx:85`（`handleTrigger`，`:88` 调 `taskV2Api.trigger`）与
  `:101`（`handleToggle`，`:104` 调 `taskV2Api.toggle`）写成
  `try { await taskV2Api.trigger/toggle(...); refresh(); } catch { toast.error(...) }`，但
  `web/api/tasks-v2.ts:71` / `:74` 的这两个方法返回 `request()` 的 `ApiResponse` 信封而不是 reject——
  `packages/web-runtime/web/api/request.ts` 只对网络错误 / 超时抛异常，业务失败（`success:false` 信封或
  4xx/5xx）走正常返回路径。于是 `catch` 只在断网时可达：业务失败时既不弹
  `panelMode.tasksTriggerFailed` / `panelMode.tasksToggleFailed`，也照常 `refresh()` 把失败当成成功。
  影响范围：仅本包 `TasksPanel`（侧栏面板）的两个行内操作；整页 `AgentTasksPage` 另经 `unwrap` 处理，
  不受影响。后果是 trigger / toggle **业务失败时无任何错误反馈（静默）**，**成功时也无 toast**
  （`toast.toggled` / `toast.triggered` 等键目前只有整页消费）。
  风险：授权 / 校验类失败被静默吞掉，用户会误以为操作已生效；与列表 / 日志区已收敛的
  「失败必须可见」口径不一致。
  移除条件：`web/api/tasks-v2.ts` 的 `trigger` / `toggle` 改为 reject 语义（在 API 层 `unwrap`），
  或在 `TasksPanel` 调用点检查信封 `success === false` 后补齐失败反馈，并给成功路径补 `toast.success`；
  两条路任选其一即可移除此条目。改动落在本包 `web/**`，随 W3 或后续波次收口。
- **宿主 `apps/web` 直连（§1.6 T11e 后）**：`routes/agent/_panel/tasks.tsx` 这个薄 route adapter 已改指
  `@fenix/resource-task/web`（保留在宿主是既定分工）；`vite.config.ts` 的 `@/src/api/tasks-v2` 与
  `@/src/pages/agent-panel/pages/AgentTasksPage` 两条 alias 随之失去全部消费方。`apps/web/src/shell/ArtifactsPanel.tsx`
  的 `TasksPanel` import 原先是穿透包内的深层相对路径（`../../../../packages/resources/task/web/pages/agent-panel/TasksPanel`），
  已随 §1.6 T11e-4b 改为 `@fenix/resource-task/web`；宿主侧自此不再有绕过 `exports` 的写法。上述两条 alias
  与其他全部桥接条目同批从宿主两张别名表删除（2026-09-21 实测 `git grep -n '"@/src/api/tasks-v2"'` 0 命中）。
- **i18n 两侧均已落地（2026-09-20 实测，切换由 W3 完成）**：字典在 `web/i18n/locales/{en,zh}/tasks-v2.json`
  （计划 §4 的形状，W2.5 迁移；旧路径 `web/i18n/{en,zh}/` 已无引用），宿主
  `apps/web/src/i18n/index.ts:23` 已改为子路径 `@fenix/resource-task/web/i18n`，`:119` / `:133` 用
  `tasksV2Resources.en/zh` 以 `TASKS_V2_NS` 登记；宿主不再按相对路径 import 包内 JSON。宿主的 `NS` 表
  改为 `{ ...SHARED_NS }` 后已无 `"tasksV2"` 字面量（`web-runtime` 的中心表持有该值），本包
  `TASKS_V2_NS` 与宿主注册同源。
- **宿主 `components.json` 待删键**：6 个 `panelMode.tasks*`（`tasksEmpty` / `tasksListTitle` /
  `tasksLoadFailed` / `tasksManage` / `tasksToggleFailed` / `tasksTriggerFailed`，读者已改为读本包字典）
  与 2 个全仓无读者键（`tasksCount` / `tasksViewLogs`）——位于宿主
  `apps/web/src/i18n/locales/{en,zh}/components.json:57-64`（`tasks` 单数在 :56，不在清单内），
  按 `grep -rn 'tasksCount\|tasksViewLogs' apps packages --include='*.ts' --include='*.tsx'` 除字典自身外
  0 命中。删除属共享文件波次，本包只记录清单。
  `panelMode.tasks`（单数）不在此列：宿主 `apps/web/src/components/agent-panel/TopModeTabs.tsx:23`
  仍用它渲染面板标签，属宿主面板外壳的文案。
- **6 个 `error.*` 键无读取方**（`invalidHeaders` / `nameRequired` / `cronRequired` / `urlRequired` /
  `agentRequired` / `promptRequired`）：迁移前的宿主 `TaskForm` 也只渲染 zod message，属既有死键；保留是为了
  不与 EE 侧可能的使用方冲突，删除需一次全仓核对（W5 收口或 EE 复盘）。
- **表定义已迁入本包（§1.7 B12），台账条目随之删除**：`apps-boundary @fenix/resource-task` 的条目
  （owner 1.7、rationale「实测 6 处导入 / 6 个文件，全部为 `@server/db/schema` 表定义导入」）已失效并删除，
  台账至此 17 条。`package.json` 因此新增 `@fenix/identity`（`workspace:*`）——`scheduled_task_v2.user_id`
  的外键列对象来自 `@fenix/identity/db`，属组装期例外（见「依赖边界」首段），**不进** `dependsOn`（装配校验
  只扫 `src/**`）。浏览器面守卫的负例（注入 `./server` 出口）原先靠「图里存在 `@server/` 引用」证明递归有效，
  载体消失后改为零容忍 `toEqual([])` + 两条深度断言（走到包内仓储与 `db/schema.ts`）。
- **浏览器面守卫的断言范围收在「本包 + 共享基础设施包」**（2026-09-20 W2.5 实测并已按此实现）：本包经
  `@fenix/agent-config/web` 消费兄弟资源包，而兄弟包的文件不属本包红线（一个文件只有一个 owner），其内部
  卫生由各自的 `web/__tests__/*-browser-surface` 守卫负责；本包对它们只保留「解析 / 穿透 / node 内建 /
  `@server`」断言。这条范围当初由**上游迁移中间态**触发：`@fenix/agent-config/web` 曾按 §6.5 消费
  `@fenix/identity/web`（`useOrg` 取宿主同一份 context），于是 identity 尚未迁完的 `web/**`（当日实测
  35 → 44 处别名，另有 `better-auth` 等库）经两跳进入本包的值导入图，由 agent-config 以
  `UPSTREAM_ALIAS_DEBT_DIRS` 登记。§1.6 T7 后那条边已不存在——组织/会话取值改经 `@fenix/web-runtime` 的
  `contexts/org-session` 契约，identity 不再进入任何资源包的值导入图。范围规则本身保留（它表达的是
  owner 边界，不依赖当下是否有债务），只是不再有正在生效的例外。
  反之，共享基础设施包（ui-components / web-runtime）是白名单断言的责任范围，其新增外部库必须在这里评审。
- **宿主侧两处已收口（2026-09-22 订正）**：`deploy/assembly/ce.json` 的 `resources` 已登记本模块（实测 13 项含 `task`，`web` 9 项亦含 `task`；本行此前记的「仍是空列表、登记本模块属 W3 装配清单」自 `c9620787` 起已闭环）；
  宿主 `apps/server/src/__tests__/task-schema.test.ts:3` 已随 §1.7 B12 改从本包出口 `@fenix/resource-task/db`
  取 `taskExecutionLog`（宿主经 owner `./db` 读写，§6.1 组装期例外的既有形态；该文件仍留在宿主是既有分工——
  `scripts/__tests__/rmd-07-migration.test.ts` 与 `scripts/root-source-owner-rules.ts` 都按宿主路径登记它）；
  文件内自写的 SQLite 建表 DDL 与列名断言不变（不取 Drizzle 表对象的断言本来就不受迁移影响）。
