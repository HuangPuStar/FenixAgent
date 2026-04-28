# 定时 Agent 任务 执行计划

**目标:** 将现有定时 HTTP 任务能力重构为面向 environment 的定时 Agent 任务，支持独立 workspace 执行、超时终止、跳过并发触发和执行结果留存。

**技术栈:** Hono、Drizzle ORM + SQLite、node-schedule、Node child_process、React + Vite + DataTable/FormDialog

**设计文档:** `spec/feature_20260427_F001_scheduled-agent-tasks/spec-design.md`

## 改动总览

- 本次改动围绕现有 `scheduled_task` 领域做替换而非并存：Task 1 先收敛数据库字段，Task 2 新增一次性 Agent 执行器，Task 3/4 分别承接任务服务与调度器，Task 5/6 完成结果目录可查看性和前端重构。
- 经代码分析确认，当前任务链路集中在 `src/services/task.ts`、`src/services/scheduler.ts`、`src/routes/web/tasks.ts`，没有其他隐藏调用点；重构这三层即可保持 `/web/tasks` 外部入口不变。
- 经代码分析确认，当前文件浏览 API 在 `src/routes/web/files.ts` 中只允许访问 `workspacePath/user`，与设计稿要求的 `workspacePath/.scheduled-runs/...` 不兼容；因此必须补一层 workspace-root 访问能力，前端再基于现有 files API 展示目录内容。
- 经本地文档 `docs/opencode-config-research.md` 第 9 节确认，`opencode run` 是现成的非交互命令入口；本次不复用 ACP relay，会在独立 workspace 中直接启动一次性 `opencode run` 进程，并通过项目级 `.opencode/config.json` 锁定 environment 对应的 agent。

---

### Task 0: 环境准备

**背景:**
确保 Bun、类型检查、后端测试、前端构建在当前仓库内可用，避免后续执行计划时被工具链问题阻塞。

**执行步骤:**
- [x] 验证 Bun 运行时可用
  - `bun --version`
  - 原因: 本仓库的构建、测试、启动均依赖 Bun。
- [x] 验证 TypeScript 类型检查命令可运行
  - `bun run typecheck`
  - 原因: Task 1-6 会同时改动后端与前端类型，需先确认类型检查入口可用。
- [x] 验证后端测试框架可运行
  - `bun test src/__tests__/store.test.ts`
  - 原因: 后端单测统一通过 Bun test 执行，先用现有稳定测试确认运行环境正常。
- [x] 验证前端构建命令可运行
  - `bun run build:web`
  - 原因: 设计稿要求前端改动后必须重新构建 `web/dist`。

**检查步骤:**
- [x] 检查 Bun 版本输出正常
  - `bun --version`
  - 预期: 输出非空版本号，不出现 `command not found`
- [x] 检查类型检查入口正常
  - `bun run typecheck 2>&1 | head -5`
  - 预期: 命令能启动 TypeScript 编译流程，不出现脚本缺失错误
- [x] 检查后端测试入口正常
  - `bun test src/__tests__/store.test.ts 2>&1 | tail -5`
  - 预期: 输出包含 `pass` 或测试摘要，不出现测试运行器初始化错误
- [x] 检查前端构建入口正常
  - `bun run build:web 2>&1 | tail -5`
  - 预期: 输出包含 Vite 构建完成信息，不出现路径解析错误

---

### Task 1: 收敛任务数据模型

**背景:**
当前 `scheduled_task` 和 `task_execution_log` 仍是 HTTP 请求模型，`src/services/task.ts`、`src/services/scheduler.ts`、前端页面都直接依赖这些旧字段。要替换为定时 Agent 任务，必须先把表结构和 schema 导出改成 environment/task/workspace 语义。Task 2-6 都依赖本 Task 的字段收敛结果。

**涉及文件:**
- 修改: `src/db/schema.ts`
- 修改: `src/db/index.ts`
- 修改: `src/__tests__/task-schema.test.ts`

**执行步骤:**
- [x] 在 `src/db/schema.ts` 中重排 `environment`、`scheduledTask`、`taskExecutionLog` 的声明顺序并替换字段定义
  - 位置: 当前 `scheduledTask`/`taskExecutionLog` 定义块位于 `src/db/schema.ts:76-116`，先移除这两个块，再在 `environment` 表定义之后插入新版本
  - 将 `scheduledTask` 改为:
    ```ts
    export const scheduledTask = sqliteTable("scheduled_task", {
      id: text("id").primaryKey(),
      userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
      name: text("name").notNull(),
      description: text("description"),
      cron: text("cron").notNull(),
      timezone: text("timezone"),
      enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
      environmentId: text("environment_id").notNull().references(() => environment.id, { onDelete: "cascade" }),
      task: text("task").notNull(),
      timeoutMinutes: integer("timeout_minutes").notNull().default(30),
      lastRunAt: integer("last_run_at", { mode: "timestamp" }),
      nextRunAt: integer("next_run_at", { mode: "timestamp" }),
      lastStatus: text("last_status"),
      createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
      updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    });
    ```
  - 将 `taskExecutionLog` 改为:
    ```ts
    export const taskExecutionLog = sqliteTable("task_execution_log", {
      id: text("id").primaryKey(),
      taskId: text("task_id").notNull().references(() => scheduledTask.id, { onDelete: "cascade" }),
      status: text("status").notNull(),
      error: text("error"),
      duration: integer("duration"),
      triggeredBy: text("triggered_by").notNull().default("cron"),
      workspacePath: text("workspace_path"),
      workspaceName: text("workspace_name"),
      environmentId: text("environment_id"),
      environmentName: text("environment_name"),
      taskSnapshot: text("task_snapshot"),
      skipReason: text("skip_reason"),
      resultSummary: text("result_summary"),
      createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    });
    ```
  - 原因: 让 Drizzle schema 与设计稿保持同构，彻底删除 HTTP 字段与 retry 语义。
- [x] 在 `src/db/index.ts` 的 `initDb()` SQL 中同步替换 `scheduled_task` 与 `task_execution_log` 建表语句
  - 位置: `src/db/index.ts:123-161`
  - 删除 `url`、`method`、`headers`、`body`、`timeout`、`retry_*`、`status_code`、`response_body`、`attempt` 列；新增 `environment_id`、`task`、`timeout_minutes`、`workspace_*`、`task_snapshot`、`skip_reason`、`result_summary`
  - 为 `scheduled_task` 新增 `CREATE INDEX IF NOT EXISTS idx_scheduled_task_environment_id ON scheduled_task(environment_id);`
  - 保留 `idx_task_execution_log_task_id` 与 `idx_task_execution_log_created_at`
  - 原因: 启动建表 SQL 必须与 Drizzle schema 完全一致，否则测试和运行时会出现字段漂移。
- [x] 更新 `src/__tests__/task-schema.test.ts`，把 schema 断言和内存 SQLite 建表 SQL 改成 Agent 任务版本
  - 位置: 当前文件中所有关于 `url`、`method`、`retryEnabled`、`statusCode`、`responseBody`、`attempt` 的断言
  - 将断言替换为 `environmentId`、`task`、`timeoutMinutes`、`workspacePath`、`workspaceName`、`taskSnapshot`、`skipReason`、`resultSummary`
  - 在级联删除场景中，为 `scheduled_task` 插入一条带 `environment_id` 的记录；先创建 `environment` 表并插入一条 `environment` 记录，再插入任务记录
  - 原因: 让 schema 测试直接覆盖新外键和列结构，避免执行计划后遗留旧断言。
- [x] 为本 Task 核心逻辑编写单元测试
  - 测试文件: `src/__tests__/task-schema.test.ts`
  - 测试场景:
    - schema 列名导出: `scheduledTask`/`taskExecutionLog` 包含 `environmentId`、`task`、`timeoutMinutes`、`workspacePath`、`resultSummary`
    - CREATE TABLE SQL 执行: 内存 SQLite 建表后 `scheduled_task` 与 `task_execution_log` 的列数和列名匹配新设计
    - 级联删除: 删除 user 后 `scheduled_task` 清空；删除 `scheduled_task` 后 `task_execution_log` 清空
  - 运行命令: `bun test src/__tests__/task-schema.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 schema 已删除 HTTP 字段
  - `rg -n "url:|method:|retryEnabled|statusCode|responseBody|attempt" src/db/schema.ts src/db/index.ts src/__tests__/task-schema.test.ts`
  - 预期: 不再出现任务表和日志表的旧 HTTP 字段定义
- [x] 检查任务表已新增 environment/task 字段
  - `rg -n "environmentId|timeoutMinutes|workspacePath|taskSnapshot|resultSummary" src/db/schema.ts src/db/index.ts src/__tests__/task-schema.test.ts`
  - 预期: 三个文件都出现新字段名
- [x] 运行 Task 1 单测
  - `bun test src/__tests__/task-schema.test.ts`
  - 预期: 全部通过

---

### Task 2: 新增一次性 Agent 执行器

**背景:**
当前仓库只有 `src/services/instance.ts` 里的 `acp-link -- ... opencode -- acp` 长连接启动逻辑，没有后台一次性 Agent 执行封装。设计稿要求调度器不要复用 relay/WebSocket，而是在独立 workspace 中直接执行一次性任务。本 Task 产出的 runner 会被 Task 3 的任务服务和 Task 4 的调度器共同依赖。

**涉及文件:**
- 新建: `src/services/agent-task-runner.ts`
- 新建: `src/__tests__/agent-task-runner.test.ts`

**执行步骤:**
- [x] 新建 `src/services/agent-task-runner.ts`，定义输入输出类型和环境查询 helper
  - 位置: 新文件顶部
  - 导出:
    ```ts
    export interface RunAgentTaskInput {
      userId: string;
      environmentId: string;
      taskId: string;
      taskText: string;
      timeoutMinutes: number;
      logId: string;
    }

    export interface AgentTaskRunResult {
      status: "success" | "failed" | "timeout";
      workspacePath: string;
      workspaceName: string;
      resultSummary: string | null;
      error: string | null;
      duration: number;
    }
    ```
  - 在文件内新增 `resolveExecutable()`, `formatRunTimestamp()`, `buildRunWorkspacePath()`, `summarizeOutput()` 辅助函数
  - 原因: 将一次性进程执行、workspace 生成和输出摘要集中在单文件，避免调度器夹带子进程细节。
- [x] 在 `src/services/agent-task-runner.ts` 中实现 environment 校验与 workspace 初始化
  - 位置: `runAgentTask()` 主函数开头
  - 通过 `db.select().from(environment)` 按 `environment.id + userId` 查询环境；不存在时抛出 `Environment not found`
  - 生成目录: `join(env.workspacePath, ".scheduled-runs", taskId, `${yyyyMMdd-HHmmss}-${logId}`)`
  - 依次执行 `mkdir(runDir, { recursive: true })`、`mkdir(join(runDir, ".opencode"), { recursive: true })`
  - 始终在 `join(runDir, ".opencode", "config.json")` 写入 JSON 配置：`agentName` 非空时写入 `{"default_agent":"<agentName>"}`，空值时写入 `{}`
  - 原因: 通过项目级 `.opencode/config.json` 锁定本次执行使用 environment 对应 agent，而不是依赖未知 CLI flag。
- [x] 在 `src/services/agent-task-runner.ts` 中实现 `opencode run` 子进程执行和超时控制
  - 位置: `runAgentTask()` 中 workspace 初始化之后
  - 使用 `spawn(opencodePath, ["run", taskText], { cwd: runDir, env: { ...process.env, OPENCODE_DISABLE_TELEMETRY: "1" }, stdio: ["ignore", "pipe", "pipe"] })`
  - 用 `setTimeout()` 在 `timeoutMinutes * 60_000` 到期后发送 `SIGTERM`，5 秒后补 `SIGKILL`；超时时记录 `timedOut = true`
  - 收集 stdout/stderr 到字符串缓冲区，结束后生成 `resultSummary`:
    - 成功: 取 stdout 最后 2000 字符
    - 失败或超时: 取 `stderr || stdout` 最后 2000 字符
  - 返回值规则:
    - `exitCode === 0 && !timedOut` → `status: "success"`
    - `timedOut === true` → `status: "timeout"`, `error: "Task execution timed out"`
    - 其他情况 → `status: "failed"`, `error: stderr.trim() || "Task execution failed"`
  - 原因: 定时后台任务需要确定性的退出码、超时和摘要规则，调度器只消费结果对象。
- [x] 为 runner 编写独立单元测试，使用 Bun mock 覆盖目录生成、agent 配置文件写入和超时分支
  - 测试文件: `src/__tests__/agent-task-runner.test.ts`
  - 位置: 参照 `src/__tests__/scheduler.test.ts` 的 `mock.module()` 写法，在 import 之前 mock `node:child_process`
  - 测试场景:
    - 成功执行: mock `spawn` 产出 stdout 和 `close(0)` → 返回 `success`，workspace 目录包含 `.opencode/config.json`
    - 超时执行: mock 长时间不退出，触发 kill timer → 返回 `timeout`，`error` 为 `Task execution timed out`
    - 环境不存在: 传入不存在的 `environmentId` → 抛出 `Environment not found`
  - 运行命令: `bun test src/__tests__/agent-task-runner.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查新 runner 导出了统一结果类型和主函数
  - `rg -n "export interface AgentTaskRunResult|export async function runAgentTask" src/services/agent-task-runner.ts`
  - 预期: 两个导出都存在
- [x] 检查执行目录规则和 `opencode run` 命令已写入
  - `rg -n "\\.scheduled-runs|opencode\", \\[\"run\"" src/services/agent-task-runner.ts`
  - 预期: 同时出现 `.scheduled-runs` 和 `spawn(opencodePath, ["run", taskText]`
- [x] 运行 Task 2 单测
  - `bun test src/__tests__/agent-task-runner.test.ts`
  - 预期: 全部通过

---

### Task 3: 重构任务服务为 Agent 任务语义

**背景:**
当前 `src/services/task.ts` 从类型、校验、手动触发到日志模型都围绕 HTTP fetch 展开，且 `triggerTask()` 自己直接执行请求。要支撑定时 Agent 任务，任务服务必须接管 environment 所有权校验、字段归一化、日志落库和手动触发流程，并把实际执行委托给 Task 2 的 runner。Task 4 的调度器和路由层都依赖本 Task 的新服务接口。

**涉及文件:**
- 修改: `src/services/task.ts`
- 修改: `src/__tests__/task-core.test.ts`

**执行步骤:**
- [x] 在 `src/services/task.ts` 顶部替换任务输入输出类型，删除全部 HTTP 字段
  - 位置: `src/services/task.ts:13-67`
  - 将 `CreateTaskInput` 改为:
    ```ts
    export interface CreateTaskInput {
      name: string;
      description?: string;
      cron: string;
      timezone?: string | null;
      environmentId: string;
      task: string;
      timeoutMinutes?: number;
    }
    ```
  - 将 `TaskResponse` 改为返回 `environmentId`、`environmentName`、`task`、`timeoutMinutes`，并将 `timezone` 设为 `string | null`
  - 将 `TaskExecutionLogResponse` 改为返回 `workspacePath`、`workspaceName`、`environmentId`、`environmentName`、`taskSnapshot`、`skipReason`、`resultSummary`
  - 原因: 服务层类型是 routes、scheduler、frontend 的共同契约，必须先收敛成新语义。
- [x] 在 `src/services/task.ts` 中新增 owned environment 校验与日志序列化 helper
  - 位置: `sanitizeTask()` 之前新增 `getOwnedEnvironment()`、`sanitizeExecutionLog()`、`normalizeTimezone()`、`validateTimeoutMinutes()`
  - `normalizeTimezone("")` 和 `normalizeTimezone(undefined)` 都返回 `null`
  - `getOwnedEnvironment(userId, environmentId)` 通过 `db.select().from(environment)` 校验 environment 归属，并返回 `name`/`workspacePath`/`agentName`
  - `validateTaskInput()` 只保留 name、cron、environmentId、task、timeoutMinutes 的校验；`task` 长度限制写死为 `1-10000`，`timeoutMinutes` 限制为 `1-180`
  - 原因: 创建和更新都需要统一做 environment 归属校验，避免路由层重复查库。
- [x] 重写 `createTask()`、`updateTask()`、`listTasks()`、`getTask()`，统一关联 environment 名称
  - 位置: `src/services/task.ts:137-212`
  - `createTask()`/`updateTask()` 在写库前先调用 `getOwnedEnvironment()`
  - `listTasks()` 和 `getTask()` 改为查询后按 `environmentId` 批量加载 environment 名称，再返回 `environmentName`
  - `createTask()` 默认 `timeoutMinutes = 30`，`timezone` 经 `normalizeTimezone()` 处理后写入 `null`
  - 更新时允许修改 `enabled`，但不再处理 retry 字段
  - 原因: 任务列表页和日志视图都要直接展示 environment 名称，服务层聚合一次即可。
- [x] 在 `src/services/task.ts` 中新增统一执行入口，供手动触发和调度器复用
  - 位置: `clearExecutionLogs()` 之前新增 `executeTaskById(taskId: string, triggeredBy: "cron" | "manual")`
  - 执行流程固定为:
    1. 根据 `taskId` 读取任务和 environment 信息
    2. 先生成 `logId = generateLogId()`
    3. 调用 `runAgentTask({ userId, environmentId, taskId, taskText: task.task, timeoutMinutes: task.timeoutMinutes, logId })`
    4. 用 runner 返回值写入 `task_execution_log`
    5. 更新 `scheduled_task.lastRunAt`、`lastStatus`、`updatedAt`
    6. 返回 `TaskExecutionLogResponse`
  - 手动触发 `triggerTask()` 只保留所有权检查后转调 `executeTaskById(taskId, "manual")`
  - 原因: 让调度触发和手动触发完全复用同一套日志与状态落库逻辑。
- [x] 在 `src/services/task.ts` 中保留并改造 `createExecutionLog()`/`getTaskById()`
  - 位置: `src/services/task.ts:352-382`
  - `getTaskById()` 返回包含新字段的原始 task row
  - `createExecutionLog()` 签名替换为:
    ```ts
    export async function createExecutionLog(params: {
      taskId: string;
      status: "success" | "failed" | "timeout" | "skipped";
      error?: string | null;
      duration?: number | null;
      triggeredBy?: "cron" | "manual";
      workspacePath?: string | null;
      workspaceName?: string | null;
      environmentId?: string | null;
      environmentName?: string | null;
      taskSnapshot?: string | null;
      skipReason?: string | null;
      resultSummary?: string | null;
    })
    ```
  - 不再截断 `responseBody`，改为对 `resultSummary` 截断到 2000 字符
  - 原因: Task 4 的调度器在跳过分支仍要复用日志写入 helper。
- [x] 为任务服务重写单元测试，覆盖新字段、environment 校验和手动触发日志
  - 测试文件: `src/__tests__/task-core.test.ts`
  - 测试场景:
    - 创建任务: `environmentId + task + timeoutMinutes` 正常写入，`timezone=""` 被归一化为 `null`
    - 非本人 environment: `createTask/updateTask` 返回 `VALIDATION_ERROR`
    - 手动触发: mock `runAgentTask()` 返回 success/timeout → `triggerTask()` 写入 `workspacePath`、`resultSummary`、`lastStatus`
    - 日志分页: `listExecutionLogs()` 返回 `workspacePath`、`skipReason`、`resultSummary`
  - 运行命令: `bun test src/__tests__/task-core.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查服务层已删除 HTTP 字段
  - `rg -n "url|method|headers|body|retryEnabled|responseBody|statusCode|attempt" src/services/task.ts src/__tests__/task-core.test.ts`
  - 预期: 不再出现旧任务语义字段
- [x] 检查服务层已接入 runner 和 environment 聚合
  - `rg -n "runAgentTask|environmentName|timeoutMinutes|taskSnapshot|resultSummary" src/services/task.ts`
  - 预期: 新字段和 runner 调用均存在
- [x] 运行 Task 3 单测
  - `bun test src/__tests__/task-core.test.ts`
  - 预期: 全部通过

---

### Task 4: 重构调度器与任务路由

**背景:**
当前 `src/services/scheduler.ts` 直接 `fetch(task.url)`，并带有 retry 分支；`src/routes/web/tasks.ts` 只是围绕旧服务薄封装。设计稿要求保留 `/web/tasks` 和 `node-schedule`，但触发器要改成 Agent 任务、空时区走服务器本地时间、并发触发时写 `skipped` 日志且不再重试。本 Task 的输出会被 Task 6 前端直接消费。

**涉及文件:**
- 修改: `src/services/scheduler.ts`
- 修改: `src/routes/web/tasks.ts`
- 修改: `src/__tests__/scheduler.test.ts`
- 修改: `src/__tests__/task-routes.test.ts`

**执行步骤:**
- [x] 在 `src/services/scheduler.ts` 中删除 HTTP fetch 和 retry 逻辑，改为调用 Task 3 的统一执行入口
  - 位置: `src/services/scheduler.ts:19-109`
  - 将 `getTaskById, createExecutionLog` 导入替换为 `getTaskById, createExecutionLog, executeTaskById`
  - `executeTask()` 在 `runningTasks.has(taskId)` 分支中直接:
    1. 读取 task
    2. 调用 `createExecutionLog({ taskId, status: "skipped", triggeredBy: "cron", environmentId: task.environmentId, taskSnapshot: task.task, skipReason: "previous_run_still_active" })`
    3. 更新 `scheduled_task.lastStatus = "skipped"` 与 `updatedAt`
    4. `return`
  - 非跳过分支只负责并发保护和 `executeTaskById(taskId, "cron")`
  - 原因: 让调度器只负责调度状态与并发保护，不重复业务执行细节。
- [x] 在 `src/services/scheduler.ts` 中修正时区和 nextRunAt 计算
  - 位置: `scheduleTask()`，当前为 `src/services/scheduler.ts:112-146`
  - 调用 `schedule.scheduleJob()` 时改为:
    ```ts
    const job = task.timezone
      ? schedule.scheduleJob({ rule: task.cron, tz: task.timezone }, handler)
      : schedule.scheduleJob({ rule: task.cron }, handler);
    ```
  - 写库前统一将 `job.nextInvocation()` 转成 `Date | null`
  - 日志文本中把 `(tz: ${task.timezone ?? "UTC"})` 改为 `(tz: ${task.timezone ?? "server-local"})`
  - 原因: 设计稿明确要求空时区不传 `tz`，由 node-schedule 使用服务器本地时间。
- [x] 在 `src/routes/web/tasks.ts` 中适配新的请求/响应字段和错误分支
  - 位置: 整个文件，重点是 `POST /tasks`、`PUT /tasks/:id`、`POST /tasks/:id/trigger`
  - `POST`/`PUT` 直接把 body 交给新 `createTask()`/`updateTask()`；响应 JSON 保持 `{ success, data }`
  - `POST /tasks/:id/trigger` 返回的 `data` 改为日志记录对象，包含 `workspacePath`、`resultSummary`、`triggeredBy`
  - `GET /tasks/:id/logs` 返回的新日志结构不再包含 `statusCode`/`responseBody`/`attempt`
  - 原因: 路由层是前端唯一消费入口，必须同步切换契约。
- [x] 更新调度器和路由测试，使其覆盖 `skipped`、空时区、本地环境校验和新日志结构
  - 测试文件: `src/__tests__/scheduler.test.ts`
  - 测试场景:
    - `scheduleTask({ timezone: null })` 时 `mockScheduleJob` 接收到的配置对象不包含 `tz`
    - 同一任务重复触发时创建一条 `skipped` 日志
    - `startScheduler()` 只调度 enabled 任务，且读取的是新 schema 字段
  - 测试文件: `src/__tests__/task-routes.test.ts`
  - 测试场景:
    - `POST /tasks` 需要 `environmentId + task`，返回 201 且调度器被调用
    - `PUT /tasks/:id` 修改 `timeoutMinutes`/`enabled` 后重新调度
    - `POST /tasks/:id/trigger` 返回 `workspacePath` 与 `resultSummary`
    - `GET /tasks/:id/logs` 不再返回 `statusCode` 和 `responseBody`
  - 运行命令: `bun test src/__tests__/scheduler.test.ts src/__tests__/task-routes.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查调度器已删除 retry 和 fetch
  - `rg -n "retry|fetch\\(|statusCode|responseBody" src/services/scheduler.ts`
  - 预期: 不再出现重试或 HTTP 请求逻辑
- [x] 检查空时区走 server-local 分支
  - `rg -n "server-local|scheduleJob\\(\\{ rule: task.cron \\}" src/services/scheduler.ts`
  - 预期: 同时出现 `server-local` 日志文案和不带 `tz` 的调度分支
- [x] 运行 Task 4 单测
  - `bun test src/__tests__/scheduler.test.ts src/__tests__/task-routes.test.ts`
  - 预期: 全部通过

---

### Task 5: 让 `.scheduled-runs` 目录可通过文件 API 查看

**背景:**
设计稿要求执行结果目录位于 `workspacePath/.scheduled-runs/...` 且“用户可通过现有文件浏览能力查看该目录内容”。经代码分析确认，`src/routes/web/files.ts` 当前把所有路径都绑定到 `workspacePath/user`，即使日志里拿到了 `workspacePath` 也无法读取 `.scheduled-runs`。本 Task 负责补齐后端文件访问能力，Task 6 再在前端任务页中调用它展示目录内容。

**涉及文件:**
- 修改: `src/routes/web/files.ts`
- 修改: `src/__tests__/files-route.test.ts`

**执行步骤:**
- [x] 将 `src/routes/web/files.ts` 中的 `resolveUserPath()` 重构为同时支持 `workspaceRoot` 和 `userRoot`
  - 位置: `src/routes/web/files.ts:51-85`
  - 将返回结构改为 `{ workspaceDir, userDir, resolved, displayPath }`
  - 解析规则固定为:
    - 查询参数/路由参数为空时，默认解析到 `user/`
    - 以 `user/` 开头的路径继续解析到 `join(env.workspacePath, "user")`
    - 其他相对路径一律解析到 `env.workspacePath` 根目录，例如 `.scheduled-runs/task_x/log_y`
  - 仍然使用 `resolve()` + `startsWith()` 防止越界；`workspaceDir` 越界和 `userDir` 越界都返回 `null`
  - 原因: 保持现有用户文件写入路径兼容，同时新增只读查看运行产物目录的能力。
- [ ] 在 `src/routes/web/files.ts` 的 list/read/write/upload/delete 端点中接入新的路径解析结果
  - 位置: `GET /:sessionId/files` 到 `DELETE /:sessionId/files/:filePath{.+}` 的五个 handler
  - 列表返回的 `path` 字段使用 `displayPath` 生成:
    - `user` 目录下继续返回 `user/...`
    - workspace 根目录下返回 `.scheduled-runs/...` 等相对路径
  - `GET` 和 `HEAD` 支持 `user/...` 与 workspace-root 相对路径；`PUT`/`POST`/`DELETE` 保持只允许 `user/...` 路径，命中 workspace-root 路径时返回 400
  - 原因: 本 feature 只需要查看 `.scheduled-runs`，不应顺带扩大对 workspace 根目录的写权限。
- [x] 扩展 `src/__tests__/files-route.test.ts`，增加 `.scheduled-runs` 目录的 list/read 验证
  - 位置: 现有 user 目录测试之后追加
  - 新增准备代码: 在 `join(workspaceDir, ".scheduled-runs", "task_1", "run_1")` 下创建 `report.md`
  - 测试场景:
    - `GET /web/sessions/:sessionId/files?path=.scheduled-runs/task_1/run_1` 返回文件列表
    - `GET /web/sessions/:sessionId/files/.scheduled-runs/task_1/run_1/report.md` 返回文件内容
    - `GET /web/sessions/:sessionId/files?path=../../../etc` 仍返回 404
  - 运行命令: `bun test src/__tests__/files-route.test.ts`
  - 预期: 所有测试通过
- [x] 为本 Task 核心逻辑编写单元测试
  - 测试文件: `src/__tests__/files-route.test.ts`
  - 测试场景:
    - 默认空路径仍落在 `user/`
    - `.scheduled-runs/...` 路径可列出和读取
    - 路径穿越在 userRoot 和 workspaceRoot 两个分支都被拦截
  - 运行命令: `bun test src/__tests__/files-route.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 files 路由已支持 `.scheduled-runs`
  - `rg -n "\\.scheduled-runs|workspaceDir|displayPath" src/routes/web/files.ts`
  - 预期: 出现 workspace-root 解析逻辑和 `.scheduled-runs` 相关路径
- [x] 运行 Task 5 单测
  - `bun test src/__tests__/files-route.test.ts`
  - 预期: 全部通过

---

### Task 6: 重构任务前端为 Agent 任务配置页

**背景:**
当前 `web/src/pages/TasksPage.tsx`、`web/src/api/client.ts` 和 `web/src/__tests__/tasks-page.test.ts` 全部围绕 HTTP 字段工作，表单和日志弹窗都无法表达 environment、task、timeoutMinutes、workspacePath 等新语义。Task 4 已经稳定 `/web/tasks` 契约，Task 5 已经让 `.scheduled-runs` 可读取；本 Task 负责把这些能力落到 UI，并在前端构建后生成新的 `web/dist`。

**涉及文件:**
- 修改: `web/src/api/client.ts`
- 修改: `web/src/pages/TasksPage.tsx`
- 修改: `web/src/__tests__/tasks-page.test.ts`

**执行步骤:**
- [x] 在 `web/src/api/client.ts` 中替换 `TaskInfo`/`ExecutionLogInfo` 类型和任务 API 契约
  - 位置: `web/src/api/client.ts:306-383`
  - `TaskInfo` 字段改为 `id`、`name`、`description`、`cron`、`timezone`、`enabled`、`environmentId`、`environmentName`、`task`、`timeoutMinutes`、`lastRunAt`、`nextRunAt`、`lastStatus`、`createdAt`、`updatedAt`
  - `ExecutionLogInfo` 字段改为 `id`、`taskId`、`status`、`error`、`duration`、`triggeredBy`、`workspacePath`、`workspaceName`、`environmentId`、`environmentName`、`taskSnapshot`、`skipReason`、`resultSummary`、`createdAt`
  - 保持 `apiListTasks`、`apiCreateTask`、`apiUpdateTask`、`apiTriggerTask`、`apiListTaskLogs` 方法名不变
  - 原因: 避免改动 App 路由和页面导入点，只替换类型与返回值语义。
- [x] 在 `web/src/pages/TasksPage.tsx` 顶部替换页面状态和表单校验，接入 environment 列表
  - 位置: `web/src/pages/TasksPage.tsx:1-117`
  - 新增 `apiFetchEnvironments` 导入和 `const [environments, setEnvironments] = useState<Environment[]>([])`
  - `useEffect()` 中并行加载 `apiListTasks()` 与 `apiFetchEnvironments()`
  - 将 `validateTaskForm()` 改为校验 `name`、`environmentId`、`task`、`cron`、`timeoutMinutes`
  - 新增 `LOCAL_TIMEZONE_SENTINEL = "__server_local__"`；组件内部 `formTimezone` 默认该值，提交时映射为 `""`
  - 原因: 任务创建必须可选择 environment，且 Radix Select 不能直接使用空字符串表达“服务器本地时间”。
- [x] 在 `web/src/pages/TasksPage.tsx` 中整体替换表格列、表单字段和触发提示
  - 位置: `web/src/pages/TasksPage.tsx:119-520`
  - 列表列改为 `名称`、`Cron 表达式`、`Environment`、`状态`、`上次执行`、`下次执行`、`最近结果`
  - 删除 `请求` 列和全部 HTTP 表单块，新增:
    - `Environment` 下拉框（来自 `environments.map(env => ({ value: env.id, label: env.name }))`）
    - `task` 多行文本框
    - `timeoutMinutes` 数字输入框
    - 时区说明文案 `留空则使用服务器时间`
  - `handleSave()` 的 payload 固定为 `{ name, description, cron, timezone, environmentId, task, timeoutMinutes, enabled? }`
  - `handleTrigger()` 的 toast 文案改为展示 `status`、`duration`、`workspaceName`
  - 原因: UI 必须彻底移除 HTTP 语义，避免用户看到旧字段。
- [x] 在 `web/src/pages/TasksPage.tsx` 的日志弹窗中展示 workspace 与目录内容
  - 位置: 当前日志弹窗和响应体弹窗区域，`web/src/pages/TasksPage.tsx:508` 之后
  - 删除“查看响应”弹窗，改为:
    - 直接展示 `workspacePath`、`resultSummary`、`skipReason`、`error`
    - 新增 `workspaceEntries` 状态和 `handleBrowseWorkspace(log)` 方法
    - `handleBrowseWorkspace(log)` 用 `environmentId` 在已加载 `environments` 中找到 `session_id` 和 `workspace_path`，把 `log.workspacePath` 转为相对路径后调用 `apiListFiles(sessionId, relativePath)`
    - 在日志行增加“查看目录”按钮，点击后在弹窗下方渲染只读文件列表（文件名、类型、大小）
  - 原因: Task 5 已让 files API 支持 `.scheduled-runs`，这里直接复用现有能力满足“结果目录可查看”验收项。
- [x] 更新前端页面测试并确保构建产物可生成
  - 测试文件: `web/src/__tests__/tasks-page.test.ts`
  - 测试场景:
    - 页面源码包含 `environmentId`、`timeoutMinutes`、`apiFetchEnvironments`、`apiListFiles`
    - 页面不再包含 `URL *`、`请求头`、`请求体 (JSON)`、`启用自动重试`
    - 日志区域包含 `workspacePath`、`resultSummary`、`查看目录`
    - API client 中 `TaskInfo`/`ExecutionLogInfo` 包含新字段
  - 运行命令: `bun test web/src/__tests__/tasks-page.test.ts`
  - 预期: 所有测试通过
- [x] 构建前端静态产物，确保控制面板页面可部署
  - 位置: Task 6 完成后立即执行
  - 运行命令: `bun run build:web`
  - 原因: 仓库后端直接挂载 `web/dist`，不构建则页面不会生效。

**检查步骤:**
- [x] 检查前端源码已删除 HTTP 字段
  - `rg -n "URL \\*|请求头|请求体 \\(JSON\\)|启用自动重试|formMethod|formHeaders|formRetry" web/src/pages/TasksPage.tsx web/src/api/client.ts web/src/__tests__/tasks-page.test.ts`
  - 预期: 不再出现旧 HTTP 表单与重试字段
- [x] 检查页面已接入 environment 和 workspace 浏览
  - `rg -n "apiFetchEnvironments|environmentId|timeoutMinutes|apiListFiles|查看目录|workspacePath" web/src/pages/TasksPage.tsx web/src/api/client.ts`
  - 预期: 新字段和目录查看逻辑均存在
- [x] 运行 Task 6 前端测试
  - `bun test web/src/__tests__/tasks-page.test.ts`
  - 预期: 全部通过
- [x] 验证前端构建成功
  - `bun run build:web`
  - 预期: `web/dist` 构建完成且无 error

---

### Task 7: 定时 Agent 任务验收

**状态:** 已完成（2026-04-28，本地已确认 `bun test src/__tests__/ web/src/__tests__/` 通过）

**前置条件:**
- 启动命令: `bun run start`
- 测试数据准备:
  - 先通过 `POST /web/environments` 创建一个带 `workspacePath` 的 environment，并记录返回的 `id`
  - 准备认证 Cookie：`better-auth.session_token=<有效会话>`
- 其他环境准备:
  - 确认本机可执行 `opencode run`
  - 确认目标 environment 的 `workspacePath` 可写

**端到端验证:**

1. 运行完整测试套件确保无回归
   - `bun test src/__tests__/ web/src/__tests__/`
   - 预期: 全部测试通过
   - 失败排查: 优先检查 Task 1-6 各自的测试步骤

2. 验证创建任务接口只接受 Agent 任务字段
   - `curl -s -X POST http://localhost:3000/web/tasks -H 'Content-Type: application/json' -b 'better-auth.session_token=YOUR_SESSION_COOKIE' -d '{"name":"每日巡检","cron":"*/5 * * * *","timezone":"","environmentId":"ENV_ID","task":"输出当前目录文件清单到 report.md","timeoutMinutes":30}' | jq '.data | {environmentId, task, timeoutMinutes, timezone}'`
   - 预期: 返回对象包含 `environmentId`、`task`、`timeoutMinutes: 30`，且 `timezone` 为 `null`
   - 失败排查: 检查 Task 3 任务服务字段归一化和 Task 4 路由契约

3. 验证手动触发会创建独立 workspace 并写入日志
   - `TASK_ID=$(curl -s http://localhost:3000/web/tasks -b 'better-auth.session_token=YOUR_SESSION_COOKIE' | jq -r '.data[0].id'); curl -s -X POST http://localhost:3000/web/tasks/$TASK_ID/trigger -b 'better-auth.session_token=YOUR_SESSION_COOKIE' | jq '.data | {status, workspacePath, workspaceName, resultSummary}'`
   - 预期: `workspacePath` 指向 `<workspacePath>/.scheduled-runs/<taskId>/...`，`status` 为 `success`、`failed` 或 `timeout` 之一，`workspaceName` 非空
   - 失败排查: 检查 Task 2 runner 和 Task 3 `executeTaskById()`

4. 验证执行目录可通过 files API 读取
   - `ENV_META=$(curl -s http://localhost:3000/web/environments -b 'better-auth.session_token=YOUR_SESSION_COOKIE' | jq -r '.[] | select(.id=="ENV_ID") | [.session_id, .workspace_path] | @tsv'); ENV_SESSION_ID=$(printf "%s" "$ENV_META" | cut -f1); ENV_WORKSPACE=$(printf "%s" "$ENV_META" | cut -f2); RUN_PATH=$(curl -s http://localhost:3000/web/tasks/$TASK_ID/logs -b 'better-auth.session_token=YOUR_SESSION_COOKIE' | jq -r '.data.items[0].workspacePath' | sed "s#^$ENV_WORKSPACE/##" | sed 's#^/##'); curl -s "http://localhost:3000/web/sessions/$ENV_SESSION_ID/files?path=$RUN_PATH" -b 'better-auth.session_token=YOUR_SESSION_COOKIE' | jq '.entries | length'`
   - 预期: 返回大于等于 `1`，能列出运行目录中的文件
   - 失败排查: 检查 Task 5 files 路由的 workspace-root 解析和 Task 6 的相对路径计算

5. 验证运行中重复触发会写入 `skipped` 日志
   - `bun test src/__tests__/scheduler.test.ts`
   - 预期: 包含并发跳过场景且通过，日志状态为 `skipped`、`skipReason` 为 `previous_run_still_active`
   - 失败排查: 检查 Task 4 `runningTasks` 分支和 Task 3 `createExecutionLog()`

6. 验证超时结果被终止且 workspace 保留
   - `bun test src/__tests__/agent-task-runner.test.ts src/__tests__/task-core.test.ts`
   - 预期: timeout 测试场景通过，日志 `status` 为 `timeout`，`error` 为 `Task execution timed out`
   - 失败排查: 检查 Task 2 kill timer 和 Task 3 日志映射

7. 验证前端构建后的任务页不再包含 HTTP 配置
   - `bun run build:web && rg -n "HTTP 配置|请求头|请求体 \\(JSON\\)|启用自动重试" web/src/pages/TasksPage.tsx`
   - 预期: 前端构建成功，源码中不再出现旧 HTTP 文案
   - 失败排查: 检查 Task 6 页面重构和构建步骤
