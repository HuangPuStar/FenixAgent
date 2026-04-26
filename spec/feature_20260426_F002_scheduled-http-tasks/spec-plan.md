# 定时 HTTP 任务 执行计划

**目标:** 为 RCS 添加定时 HTTP 任务管理功能，支持 cron 调度、执行历史记录、失败重试和前端可视化管理。

**技术栈:** Hono（后端路由）、Drizzle ORM（SQLite 数据模型）、node-schedule（cron 调度）、React + DataTable/FormDialog（前端页面）

**设计文档:** `spec/feature_20260426_F002_scheduled-http-tasks/spec-design.md`

## 改动总览

- 本次改动涉及 10 个文件（新建 4 + 修改 6）：新建 `src/services/task.ts`、`src/services/scheduler.ts`、`src/routes/web/tasks.ts`、`web/src/pages/TasksPage.tsx`；修改 `src/db/schema.ts`、`src/db/index.ts`、`package.json`、`src/index.ts`、`web/src/api/client.ts`、`web/src/App.tsx`，按数据模型→服务层→调度引擎→路由层→前端页面分层
- Task 1→2→3 为自底向上依赖链（数据模型→CRUD 服务→调度引擎），Task 4（路由）依赖 Task 2+3，Task 5（前端）依赖 Task 4 的 API 端点
- ID 生成沿用项目既有模式：前缀 + `randomBytes`（`task_`/`log_` 前缀），不引入新依赖；调度引擎使用 `node-schedule`，cron 表达式校验使用正则（不引入额外依赖）

---

### Task 0: 环境准备

**背景:**
确保构建和测试工具链在当前开发环境中可用，避免后续 Task 因环境问题阻塞。

**执行步骤:**

- [x] 验证 Bun 运行时和包管理器可用
  - 执行命令: `bun --version`
  - 预期: 输出 Bun 版本号

- [x] 验证 TypeScript 类型检查可用
  - 执行命令: `bun run typecheck`
  - 预期: 完成类型检查（允许有基线错误，但框架本身可运行）

- [x] 验证后端测试框架可用
  - 执行命令: `bun test src/__tests__/store.test.ts`
  - 预期: 至少一个测试文件成功运行

- [x] 验证前端构建工具可用
  - 执行命令: `bun run build:web`
  - 预期: 构建成功输出

**检查步骤:**

- [x] Bun 版本输出正常
  - `bun --version`
  - 预期: 输出包含版本号（如 1.x.x）

- [x] TypeScript 类型检查可运行
  - `bun run typecheck 2>&1 | head -5`
  - 预期: 命令正常执行（不报 command not found）

- [x] 后端测试框架可运行
  - `bun test src/__tests__/store.test.ts 2>&1 | tail -3`
  - 预期: 输出包含测试结果摘要

- [x] 前端构建可执行
  - `bun run build:web 2>&1 | tail -3`
  - 预期: 输出包含 "built in" 字样

---

### Task 1: 数据模型与依赖安装

**背景:**
为定时任务功能建立持久化基础。当前 SQLite 中只有 user/session/account/verification/apiKey/mcpTool 六张表，缺少任务定义和执行记录的存储。本 Task 新增 `scheduled_task` 和 `task_execution_log` 两张表，并安装 `node-schedule` 调度依赖。Task 2（CRUD 服务）和 Task 3（调度引擎）均依赖本 Task 的表定义和 schema 导出。

**涉及文件:**
- 修改: `src/db/schema.ts` — 新增 `scheduledTask` 和 `taskExecutionLog` 表定义
- 修改: `src/db/index.ts` — 在 `initDb()` 中追加 CREATE TABLE IF NOT EXISTS 和 CREATE INDEX 语句
- 修改: `package.json` — 安装 `node-schedule` + `@types/node-schedule`

**执行步骤:**

- [x] 安装 node-schedule 依赖
  - 执行命令: `bun add node-schedule && bun add -d @types/node-schedule`
  - 原因: Task 3 调度引擎需要 node-schedule 实现 cron 调度，提前安装避免后续 Task 阻塞

- [x] 在 `src/db/schema.ts` 末尾追加 `scheduledTask` 表定义
  - 位置: 文件末尾（`mcpTool` 表定义之后）
  - 导入: 已有 `sqliteTable, text, integer`，无需新增导入
  - 关键逻辑:
    ```typescript
    // 定时任务表
    export const scheduledTask = sqliteTable("scheduled_task", {
      id: text("id").primaryKey(),
      userId: text("user_id")
        .notNull()
        .references(() => user.id, { onDelete: "cascade" }),
      name: text("name").notNull(),
      description: text("description"),
      cron: text("cron").notNull(),
      timezone: text("timezone").notNull().default("UTC"),
      enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
      url: text("url").notNull(),
      method: text("method").notNull().default("GET"),
      headers: text("headers"),
      body: text("body"),
      timeout: integer("timeout").notNull().default(30000),
      retryEnabled: integer("retry_enabled", { mode: "boolean" }).notNull().default(false),
      retryCount: integer("retry_count").notNull().default(3),
      retryInterval: integer("retry_interval").notNull().default(60),
      lastRunAt: integer("last_run_at", { mode: "timestamp" }),
      nextRunAt: integer("next_run_at", { mode: "timestamp" }),
      lastStatus: text("last_status"),
      createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
      updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    });
    ```
  - 字段说明: `headers`/`body` 存为 JSON 字符串（TEXT），与 design 一致；`lastStatus` 允许值为 `success | failed | pending`

- [x] 在 `src/db/schema.ts` 末尾追加 `taskExecutionLog` 表定义
  - 位置: `scheduledTask` 定义之后
  - 关键逻辑:
    ```typescript
    // 任务执行日志表
    export const taskExecutionLog = sqliteTable("task_execution_log", {
      id: text("id").primaryKey(),
      taskId: text("task_id")
        .notNull()
        .references(() => scheduledTask.id, { onDelete: "cascade" }),
      status: text("status").notNull(),
      statusCode: integer("status_code"),
      responseBody: text("response_body"),
      error: text("error"),
      duration: integer("duration"),
      attempt: integer("attempt").notNull().default(1),
      triggeredBy: text("triggered_by").notNull().default("cron"),
      createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    });
    ```
  - 字段说明: `status` 允许值为 `success | failed | retrying`；`responseBody` 由调度引擎截断到 4096 字符后存入

- [x] 在 `src/db/index.ts` 的 `initDb()` 函数中追加建表和索引 SQL
  - 位置: `initDb()` 的 `sqlite.exec(...)` 模板字符串末尾（`mcp_tool` 索引之后，反引号闭合之前）
  - 在 `CREATE INDEX IF NOT EXISTS idx_mcp_tool_server_tool ON mcp_tool(server_name, tool_name);` 之后追加:
    ```sql
    CREATE TABLE IF NOT EXISTS scheduled_task (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      cron TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      enabled INTEGER NOT NULL DEFAULT 1,
      url TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'GET',
      headers TEXT,
      body TEXT,
      timeout INTEGER NOT NULL DEFAULT 30000,
      retry_enabled INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 3,
      retry_interval INTEGER NOT NULL DEFAULT 60,
      last_run_at INTEGER,
      next_run_at INTEGER,
      last_status TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_execution_log (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES scheduled_task(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      status_code INTEGER,
      response_body TEXT,
      error TEXT,
      duration INTEGER,
      attempt INTEGER NOT NULL DEFAULT 1,
      triggered_by TEXT NOT NULL DEFAULT 'cron',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_task_user_id ON scheduled_task(user_id);
    CREATE INDEX IF NOT EXISTS idx_task_execution_log_task_id ON task_execution_log(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_execution_log_created_at ON task_execution_log(created_at);
    ```
  - 原因: 索引命名沿用 `idx_表名_字段` 模式（参考已有的 `idx_api_key_user_id`、`idx_mcp_tool_server`）；`task_execution_log` 的 `task_id` 索引用于按任务查询日志，`created_at` 索引用于分页排序

- [x] 为 schema 导出和建表 SQL 编写单元测试
  - 测试文件: `src/__tests__/task-schema.test.ts`
  - 测试场景:
    - schema 导出验证: `import { scheduledTask, taskExecutionLog } from "../db/schema"` → 两个对象均为非空对象，包含正确的列名（`id`, `userId`, `cron`, `url`, `taskId`, `status` 等）
    - 建表 SQL 执行验证: 创建内存 SQLite 数据库，执行 `initDb()` 中的建表语句片段 → `scheduled_task` 和 `task_execution_log` 表存在且列数正确
    - 外键级联验证: 插入 user → 插入 scheduled_task（引用 user）→ 删除 user → scheduled_task 记录被级联删除
  - 运行命令: `bun test src/__tests__/task-schema.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 node-schedule 安装成功
  - `grep '"node-schedule"' package.json`
  - 预期: 在 dependencies 中找到 `"node-schedule"` 条目

- [x] 验证 schema 导出正确
  - `grep -c 'scheduledTask\|taskExecutionLog' src/db/schema.ts`
  - 预期: 计数 >= 2，两个表名均存在

- [x] 验证建表 SQL 包含两张新表
  - `grep -c 'scheduled_task\|task_execution_log' src/db/index.ts`
  - 预期: 计数 >= 4（每张表至少出现一次 CREATE TABLE + CREATE INDEX）

- [x] 验证类型检查无新增错误
  - `bun run typecheck 2>&1 | grep -c 'error TS'`
  - 预期: 错误数不超过当前基线（约 2 个已有错误），无与 schema.ts 或 index.ts 相关的新增错误

- [x] 运行 Task 1 单元测试
  - `bun test src/__tests__/task-schema.test.ts`
  - 预期: 所有测试通过，无失败

---

### Task 2: 任务 CRUD 服务

**背景:**
为定时任务功能提供核心业务逻辑层。当前 `src/services/` 下有 `config.ts`、`skill.ts`、`instance.ts` 等服务，但缺少任务 CRUD 服务。本 Task 新建 `src/services/task.ts`，实现任务的创建、读取、更新、删除、启停、手动触发和执行日志查询等全部业务逻辑。Task 4（API 路由层）将直接调用本 Task 导出的函数，Task 3（调度引擎）将通过数据库读取任务配置并调用本 Task 的日志写入函数。本 Task 依赖 Task 1 创建的 `scheduledTask` 和 `taskExecutionLog` 表定义。

**涉及文件:**
- 新建: `src/services/task.ts`

**执行步骤:**

- [x] 新建 `src/services/task.ts`，添加导入和 ID 生成函数
  - 位置: 文件开头
  - 导入: `import { eq, and, desc, sql } from "drizzle-orm";`、`import { db } from "../db";`、`import { scheduledTask, taskExecutionLog } from "../db/schema";`、`import { randomBytes } from "node:crypto";`
  - ID 生成沿用 `api-key-service.ts` 的 `key_` 模式:
    ```typescript
    function generateTaskId(): string {
      return `task_${randomBytes(12).toString("hex")}`;
    }
    function generateLogId(): string {
      return `log_${randomBytes(12).toString("hex")}`;
    }
    ```
  - 原因: ID 生成模式与项目既有模式一致（`key_`、`inst_` 前缀 + randomBytes）

- [x] 添加 TypeScript 类型定义和 sanitize 函数
  - 位置: ID 生成函数之后
  - 定义创建/更新任务的输入类型:
    ```typescript
    export interface CreateTaskInput {
      name: string;
      description?: string;
      cron: string;
      timezone?: string;
      url: string;
      method?: string;
      headers?: Record<string, string> | null;
      body?: string | null;
      timeout?: number;
      retryEnabled?: boolean;
      retryCount?: number;
      retryInterval?: number;
    }
    export type UpdateTaskInput = Partial<CreateTaskInput> & { enabled?: boolean };
    ```
  - 定义敏感 Header 脱敏函数和 sanitize 函数，将数据库行转换为 API 响应格式（时间戳转为 Unix 秒、headers 脱敏后返回）:
    ```typescript
    const SENSITIVE_HEADER_KEYS = new Set(["authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization"]);

    function maskHeaders(headers: Record<string, string> | null): Record<string, string> | null {
      if (!headers) return null;
      const masked: Record<string, string> = {};
      for (const [key, value] of Object.entries(headers)) {
        if (SENSITIVE_HEADER_KEYS.has(key.toLowerCase())) {
          masked[key] = value.length > 4 ? `***${value.slice(-4)}` : "***";
        } else {
          masked[key] = value;
        }
      }
      return masked;
    }

    function sanitizeTask(row: any) {
      const parsedHeaders = row.headers ? JSON.parse(row.headers) : null;
      return {
        id: row.id,
        name: row.name,
        description: row.description ?? null,
        cron: row.cron,
        timezone: row.timezone,
        enabled: row.enabled,
        url: row.url,
        method: row.method,
        headers: maskHeaders(parsedHeaders),
        body: row.body ?? null,
        timeout: row.timeout,
        retryEnabled: row.retryEnabled,
        retryCount: row.retryCount,
        retryInterval: row.retryInterval,
        lastRunAt: row.lastRunAt ? Math.floor(row.lastRunAt.getTime() / 1000) : null,
        nextRunAt: row.nextRunAt ? Math.floor(row.nextRunAt.getTime() / 1000) : null,
        lastStatus: row.lastStatus ?? null,
        createdAt: Math.floor(row.createdAt.getTime() / 1000),
        updatedAt: Math.floor(row.updatedAt.getTime() / 1000),
      };
    }
    ```
  - 原因: 与 `api-key-service.ts` 中 `sanitize()` 函数模式一致，时间戳统一转 Unix 秒；敏感 Header（Authorization/Cookie/X-Api-Key 等）脱敏为尾 4 位 hint，与设计文档"Headers 安全"要求一致

- [x] 实现 cron 表达式校验函数 `validateCron`
  - 位置: sanitize 函数之后
  - 关键逻辑:
    ```typescript
    function validateCron(cron: string): string | null {
      // 标准 5 字段 cron: 分 时 日 月 周
      const parts = cron.trim().split(/\s+/);
      if (parts.length !== 5) return "cron 表达式必须为 5 字段（分 时 日 月 周）";
      // 基本字符校验：允许数字、*、?、-、/、,、L、W、#
      const validPattern = /^[\d*/?\-,LW#]+$/;
      for (const part of parts) {
        if (!validPattern.test(part)) return `cron 字段 "${part}" 包含非法字符`;
      }
      return null; // null 表示校验通过
    }
    ```
  - 原因: node-schedule 支持 5 或 6 字段 cron（含秒），本项目约定 5 字段标准 cron；不引入额外依赖，使用正则校验

- [x] 实现输入校验函数 `validateTaskInput`
  - 位置: `validateCron` 之后
  - 关键逻辑:
    ```typescript
    const VALID_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];
    function validateTaskInput(data: CreateTaskInput, isUpdate = false): string | null {
      if (!isUpdate && (!data.name || data.name.trim().length === 0)) return "任务名称不能为空";
      if (data.name && data.name.length > 128) return "任务名称不能超过 128 字符";
      if (!isUpdate && (!data.url || data.url.trim().length === 0)) return "URL 不能为空";
      if (data.url && !/^https?:\/\//.test(data.url)) return "URL 必须以 http:// 或 https:// 开头";
      if (!isUpdate && (!data.cron || data.cron.trim().length === 0)) return "cron 表达式不能为空";
      if (data.cron) {
        const cronErr = validateCron(data.cron);
        if (cronErr) return cronErr;
      }
      if (data.method && !VALID_METHODS.includes(data.method.toUpperCase())) return "HTTP 方法必须为 GET/POST/PUT/DELETE/PATCH";
      if (data.timeout !== undefined && (data.timeout < 1000 || data.timeout > 300000)) return "超时必须在 1000-300000ms 之间";
      if (data.retryCount !== undefined && (data.retryCount < 0 || data.retryCount > 10)) return "重试次数必须在 0-10 之间";
      if (data.retryInterval !== undefined && (data.retryInterval < 10 || data.retryInterval > 3600)) return "重试间隔必须在 10-3600s 之间";
      return null;
    }
    ```
  - 原因: 统一校验入口，路由层调用前先校验，避免无效数据进入数据库

- [x] 实现 `createTask(userId, data)` 函数
  - 位置: `validateTaskInput` 之后，使用 `export async function`
  - 关键逻辑:
    ```typescript
    export async function createTask(userId: string, data: CreateTaskInput) {
      const validationError = validateTaskInput(data);
      if (validationError) return { success: false, error: { code: "VALIDATION_ERROR", message: validationError } };

      const id = generateTaskId();
      const now = new Date();
      const headersJson = data.headers ? JSON.stringify(data.headers) : null;

      await db.insert(scheduledTask).values({
        id,
        userId,
        name: data.name.trim(),
        description: data.description?.trim() ?? null,
        cron: data.cron.trim(),
        timezone: data.timezone ?? "UTC",
        enabled: true,
        url: data.url.trim(),
        method: (data.method ?? "GET").toUpperCase(),
        headers: headersJson,
        body: data.body ?? null,
        timeout: data.timeout ?? 30000,
        retryEnabled: data.retryEnabled ?? false,
        retryCount: data.retryCount ?? 3,
        retryInterval: data.retryInterval ?? 60,
        lastRunAt: null,
        nextRunAt: null,  // Task 3 调度引擎启动后计算
        lastStatus: null,
        createdAt: now,
        updatedAt: now,
      });

      const [row] = await db.select().from(scheduledTask).where(eq(scheduledTask.id, id));
      return { success: true, data: sanitizeTask(row) };
    }
    ```
  - 原因: 创建时不计算 `nextRunAt`，留给 Task 3 调度引擎在 `scheduleTask()` 时计算并回写；insert 后立即 select 返回完整记录

- [x] 实现 `listTasks(userId)` 函数
  - 位置: `createTask` 之后
  - 关键逻辑:
    ```typescript
    export async function listTasks(userId: string) {
      const rows = await db.select().from(scheduledTask)
        .where(eq(scheduledTask.userId, userId))
        .orderBy(desc(scheduledTask.createdAt));
      return { success: true, data: rows.map(sanitizeTask) };
    }
    ```
  - 原因: 按创建时间倒序返回，与 `listApiKeysByUser` 的查询模式一致

- [x] 实现 `getTask(userId, taskId)` 函数
  - 位置: `listTasks` 之后
  - 关键逻辑:
    ```typescript
    export async function getTask(userId: string, taskId: string) {
      const [row] = await db.select().from(scheduledTask)
        .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)));
      if (!row) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };
      return { success: true, data: sanitizeTask(row) };
    }
    ```
  - 原因: 同时校验 taskId 和 userId 所有权，避免越权访问

- [x] 实现 `updateTask(userId, taskId, data)` 函数
  - 位置: `getTask` 之后
  - 关键逻辑:
    ```typescript
    export async function updateTask(userId: string, taskId: string, data: UpdateTaskInput) {
      // 所有权校验
      const [existing] = await db.select().from(scheduledTask)
        .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)));
      if (!existing) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };

      // 校验提供的字段
      const validationError = validateTaskInput(data as CreateTaskInput, true);
      if (validationError) return { success: false, error: { code: "VALIDATION_ERROR", message: validationError } };

      const updates: Record<string, any> = { updatedAt: new Date() };
      if (data.name !== undefined) updates.name = data.name.trim();
      if (data.description !== undefined) updates.description = data.description?.trim() ?? null;
      if (data.cron !== undefined) updates.cron = data.cron.trim();
      if (data.timezone !== undefined) updates.timezone = data.timezone;
      if (data.url !== undefined) updates.url = data.url.trim();
      if (data.method !== undefined) updates.method = data.method.toUpperCase();
      if (data.headers !== undefined) updates.headers = data.headers ? JSON.stringify(data.headers) : null;
      if (data.body !== undefined) updates.body = data.body ?? null;
      if (data.timeout !== undefined) updates.timeout = data.timeout;
      if (data.retryEnabled !== undefined) updates.retryEnabled = data.retryEnabled;
      if (data.retryCount !== undefined) updates.retryCount = data.retryCount;
      if (data.retryInterval !== undefined) updates.retryInterval = data.retryInterval;

      await db.update(scheduledTask).set(updates).where(eq(scheduledTask.id, taskId));

      const [row] = await db.select().from(scheduledTask).where(eq(scheduledTask.id, taskId));
      return { success: true, data: sanitizeTask(row) };
    }
    ```
  - 原因: 只更新传入的字段（Partial），updatedAt 始终刷新；更新后 select 返回最新数据供 Task 3 判断是否需要 reschedule

- [x] 实现 `deleteTask(userId, taskId)` 函数
  - 位置: `updateTask` 之后
  - 关键逻辑:
    ```typescript
    export async function deleteTask(userId: string, taskId: string) {
      const result = db.delete(scheduledTask)
        .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)))
        .run() as any;
      if (result.changes === 0) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };
      return { success: true };
    }
    ```
  - 原因: 与 `deleteApiKey` 模式一致，使用 `.run()` 同步执行并检查 `changes`；`task_execution_log` 通过外键 `ON DELETE CASCADE` 自动清理

- [x] 实现 `toggleTask(userId, taskId)` 函数
  - 位置: `deleteTask` 之后
  - 关键逻辑:
    ```typescript
    export async function toggleTask(userId: string, taskId: string) {
      const [existing] = await db.select().from(scheduledTask)
        .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)));
      if (!existing) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };

      const newEnabled = !existing.enabled;
      await db.update(scheduledTask)
        .set({ enabled: newEnabled, updatedAt: new Date() })
        .where(eq(scheduledTask.id, taskId));

      return { success: true, data: { id: taskId, enabled: newEnabled } };
    }
    ```
  - 原因: toggle 是原子操作（读当前值取反后写回），Task 3 调度引擎根据返回的 `enabled` 状态决定 schedule/unschedule

- [x] 实现 `triggerTask(userId, taskId)` 函数 — 手动触发并记录执行日志
  - 位置: `toggleTask` 之后
  - 关键逻辑:
    ```typescript
    export async function triggerTask(userId: string, taskId: string) {
      const [task] = await db.select().from(scheduledTask)
        .where(and(eq(scheduledTask.id, taskId), eq(scheduledTask.userId, userId)));
      if (!task) return { success: false, error: { code: "NOT_FOUND", message: "任务不存在" } };

      const logId = generateLogId();
      const startTime = Date.now();
      let status = "success";
      let statusCode: number | null = null;
      let responseBody: string | null = null;
      let errorMsg: string | null = null;

      try {
        const headers: Record<string, string> = task.headers ? JSON.parse(task.headers) : {};
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), task.timeout);

        const fetchOptions: RequestInit = {
          method: task.method,
          headers,
          signal: controller.signal,
        };
        if (task.body && ["POST", "PUT", "PATCH"].includes(task.method)) {
          fetchOptions.body = task.body;
        }

        const response = await fetch(task.url, fetchOptions);
        clearTimeout(timeoutId);
        statusCode = response.status;
        const text = await response.text();
        responseBody = text.length > 4096 ? text.slice(0, 4096) : text;
        if (!response.ok) {
          status = "failed";
          errorMsg = `HTTP ${response.status}`;
        }
      } catch (err: any) {
        status = "failed";
        errorMsg = err.message ?? String(err);
      }

      const duration = Date.now() - startTime;
      const now = new Date();

      await db.insert(taskExecutionLog).values({
        id: logId,
        taskId: task.id,
        status,
        statusCode,
        responseBody,
        error: errorMsg,
        duration,
        attempt: 1,
        triggeredBy: "manual",
        createdAt: now,
      });

      // 更新任务状态
      await db.update(scheduledTask)
        .set({ lastRunAt: now, lastStatus: status, updatedAt: now })
        .where(eq(scheduledTask.id, task.id));

      return {
        success: true,
        data: {
          id: logId,
          taskId: task.id,
          status,
          statusCode,
          responseBody,
          error: errorMsg,
          duration,
          triggeredBy: "manual",
          createdAt: Math.floor(now.getTime() / 1000),
        },
      };
    }
    ```
  - 原因: 手动触发需同步执行 HTTP 请求并返回结果；响应体截断到 4096 字符避免撑爆数据库；使用 `AbortController` 实现超时控制

- [x] 实现 `listExecutionLogs(taskId, page, pageSize)` 函数
  - 位置: `triggerTask` 之后
  - 关键逻辑:
    ```typescript
    export async function listExecutionLogs(taskId: string, page = 1, pageSize = 20) {
      const offset = (page - 1) * pageSize;
      // 查询总数
      const [{ count: total }] = await db.select({ count: sql<number>`count(*)` })
        .from(taskExecutionLog)
        .where(eq(taskExecutionLog.taskId, taskId));
      // 分页查询
      const rows = await db.select().from(taskExecutionLog)
        .where(eq(taskExecutionLog.taskId, taskId))
        .orderBy(desc(taskExecutionLog.createdAt))
        .limit(pageSize)
        .offset(offset);

      return {
        success: true,
        data: {
          total,
          items: rows.map((r) => ({
            id: r.id,
            taskId: r.taskId,
            status: r.status,
            statusCode: r.statusCode,
            responseBody: r.responseBody,
            error: r.error,
            duration: r.duration,
            attempt: r.attempt,
            triggeredBy: r.triggeredBy,
            createdAt: Math.floor(r.createdAt.getTime() / 1000),
          })),
        },
      };
    }
    ```
  - 原因: 使用 `sql`count(*)`` 获取总数（Drizzle SQLite 的 count 查询方式），`limit + offset` 实现分页，按 `createdAt` 降序

- [x] 实现 `clearExecutionLogs(taskId)` 函数
  - 位置: `listExecutionLogs` 之后
  - 关键逻辑:
    ```typescript
    export async function clearExecutionLogs(taskId: string) {
      db.delete(taskExecutionLog).where(eq(taskExecutionLog.taskId, taskId)).run();
      return { success: true };
    }
    ```
  - 原因: 使用 `.run()` 同步执行（与 `deleteApiKey` 模式一致），清空指定任务的所有执行日志

- [x] 导出辅助函数 `getTaskById` 供 Task 3 调度引擎内部使用
  - 位置: `clearExecutionLogs` 之后
  - 关键逻辑:
    ```typescript
    export async function getTaskById(taskId: string) {
      const [row] = await db.select().from(scheduledTask).where(eq(scheduledTask.id, taskId));
      return row ?? null;
    }
    ```
  - 原因: Task 3 调度引擎需要按 ID 获取任务原始记录（不需要 userId 校验），与 `getTask` 区分

- [x] 导出 `createExecutionLog` 辅助函数供 Task 3 调度引擎写入日志
  - 位置: `getTaskById` 之后
  - 关键逻辑:
    ```typescript
    export async function createExecutionLog(params: {
      taskId: string;
      status: string;
      statusCode?: number | null;
      responseBody?: string | null;
      error?: string | null;
      duration?: number | null;
      attempt?: number;
      triggeredBy?: string;
    }) {
      const logId = generateLogId();
      const now = new Date();
      await db.insert(taskExecutionLog).values({
        id: logId,
        taskId: params.taskId,
        status: params.status,
        statusCode: params.statusCode ?? null,
        responseBody: params.responseBody ? (params.responseBody.length > 4096 ? params.responseBody.slice(0, 4096) : params.responseBody) : null,
        error: params.error ?? null,
        duration: params.duration ?? null,
        attempt: params.attempt ?? 1,
        triggeredBy: params.triggeredBy ?? "cron",
        createdAt: now,
      });
      return logId;
    }
    ```
  - 原因: Task 3 的 cron 回调中需要写入执行日志，将日志创建逻辑抽取为公共函数避免代码重复；响应体截断逻辑统一在此函数内

- [x] 为 `task.ts` 核心逻辑编写单元测试
  - 测试文件: `src/__tests__/task-service.test.ts`
  - 测试策略: 使用内存 SQLite 数据库（`new Database(":memory:")`）+ `drizzle()` 创建测试专用 db 实例，通过 `mock.module("../db", ...)` 替换 db 导出；`initDb()` 建表 SQL 在测试 setup 中直接执行
  - 测试场景:
    - **validateCron 校验**: 5 字段合法 cron `"*/5 * * * *"` → 返回 null；6 字段 cron `"0 */5 * * * *"` → 返回错误信息；空字符串 → 返回错误信息；非法字符 `"abc"` → 返回错误信息
    - **validateTaskInput 校验**: name 为空 → 返回错误；url 非 http/https → 返回错误；method 非法 → 返回错误；timeout 超范围 → 返回错误；全部合法 → 返回 null
    - **createTask 创建**: 合法输入 → 返回 `{ success: true, data: { id: "task_xxx", ... } }`；重复创建相同 cron 任务 → 两个独立任务，均可成功；无效 cron → 返回 `{ success: false, error: { code: "VALIDATION_ERROR" } }`
    - **listTasks 列表**: 创建 2 个任务 → `listTasks(userId)` 返回 2 条；不同用户的任务互不可见
    - **getTask 详情**: 存在的任务 → 返回完整数据；不存在的 ID → 返回 NOT_FOUND；别人的任务 → 返回 NOT_FOUND
    - **updateTask 更新**: 更新 name → name 变更，updatedAt 刷新；更新非法 url → 返回 VALIDATION_ERROR；不存在的任务 → 返回 NOT_FOUND
    - **deleteTask 删除**: 存在的任务 → 返回 success，后续 getTask 返回 NOT_FOUND；级联删除执行日志
    - **toggleTask 启停**: enabled=true → 切换为 false；enabled=false → 切换为 true；不存在的任务 → 返回 NOT_FOUND
    - **triggerTask 手动触发**: mock fetch 返回 200 → 日志 status=success，statusCode=200，duration>0；mock fetch 超时 → 日志 status=failed，error 包含超时信息；不存在的任务 → 返回 NOT_FOUND
    - **listExecutionLogs 分页**: 插入 25 条日志 → page=1, pageSize=20 返回 20 条 + total=25；page=2 返回 5 条
    - **clearExecutionLogs 清空**: 插入 3 条日志 → 清空 → listExecutionLogs 返回 total=0
    - **createExecutionLog 辅助函数**: 调用后 task_execution_log 表有新记录；responseBody 超过 4096 字符 → 截断到 4096
    - **sanitizeTask Header 脱敏**: 创建带 Authorization header 的任务 → getTask 返回的 headers 中 Authorization 值为 `***尾4位`；非敏感 header（如 Content-Type）原样返回
  - 运行命令: `bun test src/__tests__/task-service.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 `task.ts` 文件存在且导出所有核心函数
  - `grep -c 'export async function\|export function' src/services/task.ts`
  - 预期: 计数 >= 10（createTask, listTasks, getTask, updateTask, deleteTask, toggleTask, triggerTask, listExecutionLogs, clearExecutionLogs, getTaskById, createExecutionLog）

- [x] 验证 ID 生成使用正确前缀
  - `grep 'task_\|log_' src/services/task.ts`
  - 预期: 包含 `task_` 和 `log_` 前缀的 ID 生成

- [x] 验证输入校验函数覆盖关键字段
  - `grep -c 'validateCron\|validateTaskInput\|VALID_METHODS' src/services/task.ts`
  - 预期: 计数 >= 3

- [x] 验证响应体截断逻辑存在
  - `grep -c '4096' src/services/task.ts`
  - 预期: 计数 >= 2（triggerTask 和 createExecutionLog 各一处）

- [x] 验证 Header 脱敏逻辑存在
  - `grep -c 'maskHeaders\|SENSITIVE_HEADER_KEYS' src/services/task.ts`
  - 预期: 计数 >= 2（常量定义和函数定义各一处）

- [x] 验证类型检查无新增错误
  - `bun run typecheck 2>&1 | grep -c 'error TS'`
  - 预期: 错误数不超过当前基线

- [x] 运行 Task 2 单元测试
  - `bun test src/__tests__/task-service.test.ts`
  - 预期: 所有测试通过，无失败

---

### Task 3: 调度引擎

**背景:**
为定时任务提供 cron 调度执行能力。当前系统没有定时任务调度机制，已定义的 cron 表达式无法触发 HTTP 请求。本 Task 新建 `src/services/scheduler.ts`，封装 `node-schedule` 实现 cron Job 的注册/取消/执行，并集成到 `src/index.ts` 的启动和关闭流程中。Task 4（API 路由层）在任务 CRUD 操作后调用本 Task 的 `scheduleTask`/`unscheduleTask`/`rescheduleTask` 方法来同步调度状态。本 Task 依赖 Task 1 的表定义和 Task 2 的 `getTaskById`、`createExecutionLog` 辅助函数。

**涉及文件:**
- 新建: `src/services/scheduler.ts`
- 修改: `src/index.ts` — 在 `migrateSkillsDir()` 之后调用 `startScheduler()`，在 `gracefulShutdown` 中调用 `stopScheduler()`

**执行步骤:**

- [x] 新建 `src/services/scheduler.ts`，添加导入和类型定义
  - 位置: 文件开头
  - 导入:
    ```typescript
    import schedule from "node-schedule";
    import { db } from "../db";
    import { scheduledTask } from "../db/schema";
    import { eq } from "drizzle-orm";
    import { getTaskById, createExecutionLog } from "./task";
    import { log, error } from "../logger";
    ```
  - 定义内部类型:
    ```typescript
    interface ScheduledJob {
      taskId: string;
      job: schedule.Job;
    }

    /** 正在执行中的任务集合（用于并发控制） */
    const runningTasks = new Set<string>();

    /** 内存中所有活跃的 cron Job */
    const activeJobs = new Map<string, ScheduledJob>();
    ```
  - 原因: `activeJobs` Map 维护 taskId 到 node-schedule Job 的映射，`runningTasks` Set 防止同一任务并发执行

- [x] 实现 `executeTask(taskId, triggeredBy, attempt)` 内部函数 — 单次 HTTP 请求执行
  - 位置: 类型定义之后，使用 `async function`（非 export，仅供模块内部调用）
  - 关键逻辑:
    ```typescript
    async function executeTask(taskId: string, triggeredBy: string = "cron", attempt: number = 1): Promise<void> {
      // 并发控制：同一任务如果正在执行则跳过
      if (runningTasks.has(taskId)) {
        log(`[Scheduler] Task ${taskId} is already running, skipping`);
        return;
      }
      runningTasks.add(taskId);

      try {
        const task = await getTaskById(taskId);
        if (!task) {
          log(`[Scheduler] Task ${taskId} not found, skipping`);
          return;
        }
        if (!task.enabled) {
          log(`[Scheduler] Task ${taskId} is disabled, skipping`);
          return;
        }

        const startTime = Date.now();
        let status = "success";
        let statusCode: number | null = null;
        let responseBody: string | null = null;
        let errorMsg: string | null = null;

        try {
          const headers: Record<string, string> = task.headers ? JSON.parse(task.headers) : {};
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), task.timeout);

          const fetchOptions: RequestInit = {
            method: task.method,
            headers,
            signal: controller.signal,
          };
          if (task.body && ["POST", "PUT", "PATCH"].includes(task.method)) {
            fetchOptions.body = task.body;
          }

          const response = await fetch(task.url, fetchOptions);
          clearTimeout(timeoutId);
          statusCode = response.status;
          const text = await response.text();
          responseBody = text.length > 4096 ? text.slice(0, 4096) : text;
          if (!response.ok) {
            status = "failed";
            errorMsg = `HTTP ${response.status}`;
          }
        } catch (err: any) {
          status = "failed";
          errorMsg = err.message ?? String(err);
        }

        const duration = Date.now() - startTime;
        const now = new Date();

        // 写入执行日志
        await createExecutionLog({
          taskId: task.id,
          status,
          statusCode,
          responseBody,
          error: errorMsg,
          duration,
          attempt,
          triggeredBy,
        });

        // 计算下次执行时间（从 node-schedule Job 获取）
        const job = activeJobs.get(taskId);
        const nextInvocation = job?.job?.nextInvocation();
        const nextRunAt = nextInvocation ? nextInvocation.toJSDate() : null;

        // 更新任务状态
        await db.update(scheduledTask)
          .set({ lastRunAt: now, lastStatus: status, nextRunAt, updatedAt: now })
          .where(eq(scheduledTask.id, task.id));

        // 重试逻辑：失败且启用重试且未达上限
        if (
          status === "failed" &&
          task.retryEnabled &&
          attempt < task.retryCount
        ) {
          const retryAttempt = attempt + 1;
          const retryDelayMs = task.retryInterval * 1000;
          log(`[Scheduler] Task ${taskId} failed (attempt ${attempt}/${task.retryCount}), retrying in ${task.retryInterval}s`);
          setTimeout(() => {
            executeTask(taskId, "retry", retryAttempt);
          }, retryDelayMs);
        }
      } catch (err) {
        error(`[Scheduler] Unexpected error executing task ${taskId}:`, err);
      } finally {
        runningTasks.delete(taskId);
      }
    }
    ```
  - 原因: 并发控制通过 `runningTasks` Set 实现——cron 触发时若任务已在执行则跳过；重试使用 `setTimeout` 延迟执行，`triggeredBy` 记录为 `"retry"`，`attempt` 递增；`finally` 块确保 `runningTasks` 始终清理

- [x] 实现 `scheduleTask(task)` 导出函数 — 注册单个任务的 cron 调度
  - 位置: `executeTask` 之后
  - 关键逻辑:
    ```typescript
    export function scheduleTask(task: { id: string; cron: string; timezone?: string | null; enabled?: boolean }): void {
      // 如果已有 Job，先取消
      if (activeJobs.has(task.id)) {
        unscheduleTask(task.id);
      }

      // 未启用的任务不注册调度
      if (!task.enabled) {
        log(`[Scheduler] Task ${task.id} is disabled, not scheduling`);
        return;
      }

      // 注册 cron Job
      const job = schedule.scheduleJob(
        { rule: task.cron, tz: task.timezone ?? "UTC" },
        () => {
          log(`[Scheduler] Cron triggered for task ${task.id}`);
          executeTask(task.id).catch((err) => {
            error(`[Scheduler] Error in cron execution for task ${task.id}:`, err);
          });
        }
      );

      if (job) {
        activeJobs.set(task.id, { taskId: task.id, job });
        // 计算并回写 nextRunAt
        const nextInvocation = job.nextInvocation();
        if (nextInvocation) {
          const nextRunAt = nextInvocation.toJSDate();
          db.update(scheduledTask)
            .set({ nextRunAt, updatedAt: new Date() })
            .where(eq(scheduledTask.id, task.id))
            .then(() => {})
            .catch(() => {});
        }
        log(`[Scheduler] Scheduled task ${task.id} with cron "${task.cron}" (tz: ${task.timezone ?? "UTC"})`);
      } else {
        error(`[Scheduler] Invalid cron expression "${task.cron}" for task ${task.id}, job not created`);
      }
    }
    ```
  - 原因: `scheduleTask` 具有幂等性——若已注册则先取消再注册；注册成功后立即计算 `nextRunAt` 并异步回写数据库；`schedule.scheduleJob` 返回 `null` 表示 cron 表达式无效

- [x] 实现 `unscheduleTask(taskId)` 导出函数 — 取消单个任务调度
  - 位置: `scheduleTask` 之后
  - 关键逻辑:
    ```typescript
    export function unscheduleTask(taskId: string): void {
      const entry = activeJobs.get(taskId);
      if (entry) {
        entry.job.cancel();
        activeJobs.delete(taskId);
        log(`[Scheduler] Unscheduled task ${taskId}`);
      }
    }
    ```
  - 原因: 取消后从 `activeJobs` Map 中移除，node-schedule 的 `job.cancel()` 停止后续触发

- [x] 实现 `rescheduleTask(task)` 导出函数 — 更新调度规则（取消再注册）
  - 位置: `unscheduleTask` 之后
  - 关键逻辑:
    ```typescript
    export function rescheduleTask(task: { id: string; cron: string; timezone?: string | null; enabled?: boolean }): void {
      unscheduleTask(task.id);
      scheduleTask(task);
      log(`[Scheduler] Rescheduled task ${task.id}`);
    }
    ```
  - 原因: reschedule 是 unschedule + schedule 的组合，保证先取消旧 Job 再注册新 cron 规则

- [x] 实现 `startScheduler()` 导出函数 — 服务启动时加载所有已启用任务
  - 位置: `rescheduleTask` 之后
  - 关键逻辑:
    ```typescript
    export async function startScheduler(): Promise<void> {
      try {
        const tasks = await db.select().from(scheduledTask)
          .where(eq(scheduledTask.enabled, true));
        log(`[Scheduler] Starting scheduler, found ${tasks.length} enabled tasks`);
        for (const task of tasks) {
          scheduleTask(task);
        }
        log(`[Scheduler] Scheduler started successfully`);
      } catch (err) {
        error("[Scheduler] Failed to start scheduler:", err);
      }
    }
    ```
  - 原因: 服务启动时从数据库查询所有 `enabled=true` 的任务，逐个注册 cron Job；失败不阻塞服务启动，仅记录错误日志

- [x] 实现 `stopScheduler()` 导出函数 — 取消所有活跃 Job
  - 位置: `startScheduler` 之后
  - 关键逻辑:
    ```typescript
    export function stopScheduler(): void {
      const count = activeJobs.size;
      for (const [taskId, entry] of activeJobs) {
        entry.job.cancel();
      }
      activeJobs.clear();
      runningTasks.clear();
      log(`[Scheduler] Scheduler stopped, cancelled ${count} jobs`);
    }
    ```
  - 原因: 遍历所有 Job 调用 `cancel()`，清空 `activeJobs` 和 `runningTasks`；服务关闭时由 `gracefulShutdown` 调用

- [x] 修改 `src/index.ts`，集成调度引擎启动
  - 位置: 文件顶部 import 区域（~L21，`import { migrateSkillsDir }` 之后）
  - 添加导入:
    ```typescript
    import { startScheduler, stopScheduler } from "./services/scheduler";
    ```
  - 位置: ~L25（`await migrateSkillsDir();` 之后）
  - 添加调用:
    ```typescript
    await startScheduler();
    ```
  - 原因: 在数据库初始化和 Skills 迁移完成后启动调度引擎，确保 `scheduled_task` 表已存在

- [x] 修改 `src/index.ts`，集成调度引擎优雅关闭
  - 位置: `gracefulShutdown` 函数体内（~L105，`stopAllInstances();` 之后）
  - 添加调用:
    ```typescript
    stopScheduler();
    ```
  - 最终 `gracefulShutdown` 函数:
    ```typescript
    async function gracefulShutdown(signal: string) {
      console.log(`\n[RCS] Received ${signal}, shutting down...`);
      closeAllAcpConnections();
      closeAllRelayConnections();
      stopAllInstances();
      stopScheduler();
      process.exit(0);
    }
    ```
  - 原因: 在 ACP 连接和 Instance 停止后取消所有 cron Job，确保无遗漏的定时执行

- [x] 为 `scheduler.ts` 核心逻辑编写单元测试
  - 测试文件: `src/__tests__/scheduler.test.ts`
  - 测试策略: 使用 `mock.module()` 模拟 `node-schedule`、`../db`、`../services/task`、`../logger`；使用 `mock.fn()` 追踪函数调用
  - 测试场景:
    - **scheduleTask 注册**: 给定 `enabled=true` 的任务对象 → `schedule.scheduleJob` 被调用，`activeJobs` Map 大小为 1
    - **scheduleTask 跳过禁用任务**: 给定 `enabled=false` 的任务对象 → `schedule.scheduleJob` 未被调用，`activeJobs` Map 为空
    - **scheduleTask 无效 cron**: 给定无效 cron 表达式 → `schedule.scheduleJob` 返回 null，`activeJobs` Map 为空，错误被记录
    - **scheduleTask 幂等性**: 对同一 taskId 连续调用两次 scheduleTask → `schedule.scheduleJob` 被调用两次（第二次先 cancel 再注册），`activeJobs` 大小仍为 1
    - **unscheduleTask 取消**: 先 scheduleTask 再 unscheduleTask → `job.cancel()` 被调用，`activeJobs` Map 为空
    - **unscheduleTask 不存在的任务**: 对不存在的 taskId 调用 unscheduleTask → 无报错，`activeJobs` 不变
    - **rescheduleTask 更新**: 调用 rescheduleTask → 内部先调用 unscheduleTask 再调用 scheduleTask，`activeJobs` 中任务被替换
    - **startScheduler 启动**: mock db.select 返回 3 个 enabled 任务 → `scheduleTask` 被调用 3 次，`activeJobs` 大小为 3
    - **startScheduler 无任务**: mock db.select 返回空数组 → `scheduleTask` 未被调用，`activeJobs` 为空
    - **stopScheduler 停止**: 先注册 2 个任务再 stopScheduler → 两个 `job.cancel()` 均被调用，`activeJobs` 和 `runningTasks` 均为空
    - **executeTask 并发控制**: mock `runningTasks` 已包含 taskId → cron 回调触发时跳过执行，`createExecutionLog` 未被调用
    - **executeTask 重试逻辑**: mock fetch 失败 + `retryEnabled=true` + `retryCount=3` + `attempt=1` → `createExecutionLog` 记录 status="failed"，`setTimeout` 被调度延迟 retryInterval 后重试
    - **executeTask 不重试**: mock fetch 失败 + `retryEnabled=false` → 无 `setTimeout` 调用
    - **executeTask 达到重试上限**: mock fetch 失败 + `retryEnabled=true` + `retryCount=3` + `attempt=3` → 无 `setTimeout` 调用（已达上限）
  - 运行命令: `bun test src/__tests__/scheduler.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 `scheduler.ts` 文件存在且导出所有核心函数
  - `grep -c 'export function\|export async function' src/services/scheduler.ts`
  - 预期: 计数 >= 5（scheduleTask, unscheduleTask, rescheduleTask, startScheduler, stopScheduler）

- [x] 验证 `src/index.ts` 包含 scheduler 导入和调用
  - `grep -c 'startScheduler\|stopScheduler' src/index.ts`
  - 预期: 计数 >= 3（1 处 import + 1 处 startScheduler 调用 + 1 处 stopScheduler 调用）

- [x] 验证 `src/index.ts` 中 startScheduler 调用位置正确
  - `grep -n 'startScheduler\|migrateSkillsDir' src/index.ts`
  - 预期: `startScheduler()` 出现在 `migrateSkillsDir()` 之后

- [x] 验证 `src/index.ts` 中 stopScheduler 调用位置正确
  - `grep -n 'stopScheduler\|stopAllInstances' src/index.ts`
  - 预期: `stopScheduler()` 出现在 `stopAllInstances()` 之后

- [x] 验证 scheduler.ts 使用了 node-schedule
  - `grep 'node-schedule' src/services/scheduler.ts`
  - 预期: 存在 `import schedule from "node-schedule"` 行

- [x] 验证并发控制逻辑存在
  - `grep -c 'runningTasks' src/services/scheduler.ts`
  - 预期: 计数 >= 3（声明、add、delete）

- [x] 验证重试逻辑存在
  - `grep -c 'retryEnabled\|retryCount\|retry' src/services/scheduler.ts`
  - 预期: 计数 >= 3

- [x] 验证响应体截断逻辑存在
  - `grep -c '4096' src/services/scheduler.ts`
  - 预期: 计数 >= 1

- [x] 验证类型检查无新增错误
  - `bun run typecheck 2>&1 | grep -c 'error TS'`
  - 预期: 错误数不超过当前基线

- [x] 运行 Task 3 单元测试
  - `bun test src/__tests__/scheduler.test.ts`
  - 预期: 所有测试通过，无失败

---

### Task 4: API 路由层

**背景:**
为定时任务功能提供 HTTP API 入口，让前端能够通过 REST 接口管理任务。当前 `src/routes/web/` 下有 `sessions.ts`、`environments.ts`、`api-keys.ts` 等路由文件，但缺少任务管理路由。本 Task 新建 `src/routes/web/tasks.ts`，实现 9 个端点（CRUD + 启停 + 手动触发 + 执行日志查询/清空），所有端点使用 `sessionAuth` 中间件保护。Task 5（前端页面）将直接调用这些 API。本 Task 依赖 Task 2 的 `task.ts` 服务层函数和 Task 3 的 `scheduler.ts` 调度函数。

**涉及文件:**
- 新建: `src/routes/web/tasks.ts`
- 修改: `src/index.ts` — 添加 import 和 `app.route("/web", webTasks)`

**执行步骤:**

- [x] 新建 `src/routes/web/tasks.ts`，添加导入和 Hono 实例
  - 位置: 文件开头
  - 导入:
    ```typescript
    import { Hono } from "hono";
    import { sessionAuth } from "../../auth/middleware";
    import {
      listTasks,
      createTask,
      getTask,
      updateTask,
      deleteTask,
      toggleTask,
      triggerTask,
      listExecutionLogs,
      clearExecutionLogs,
    } from "../../services/task";
    import { scheduleTask, unscheduleTask, rescheduleTask } from "../../services/scheduler";
    ```
  - 实例化: `const app = new Hono();`
  - 原因: 导入路径和模式与 `api-keys.ts` 完全一致（`sessionAuth` 从 `../../auth/middleware` 导入，服务函数从 `../../services/` 导入）；同时导入 Task 3 调度引擎的函数用于创建/更新/删除/启停任务后同步调度状态

- [x] 实现 `GET /tasks` — 列出当前用户所有任务
  - 位置: 导入之后，`export default app;` 之前
  - 关键逻辑:
    ```typescript
    /** GET /tasks — List current user's scheduled tasks */
    app.get("/tasks", sessionAuth, async (c) => {
      const user = c.get("user")!;
      const result = await listTasks(user.id);
      return c.json(result);
    });
    ```
  - 原因: 返回格式为 `{ success: true, data: [...] }`，由 `listTasks` 统一封装；与 `api-keys.ts` 的 `GET /api-keys` 模式一致

- [x] 实现 `POST /tasks` — 创建新任务
  - 位置: `GET /tasks` 之后
  - 关键逻辑:
    ```typescript
    /** POST /tasks — Create a new scheduled task */
    app.post("/tasks", sessionAuth, async (c) => {
      const user = c.get("user")!;
      const body = await c.req.json().catch(() => ({}));
      const result = await createTask(user.id, body);

      if (!result.success) {
        const status = result.error.code === "VALIDATION_ERROR" ? 400 : 500;
        return c.json({ error: { type: "validation_error", message: result.error.message } }, status);
      }

      // 创建成功后注册调度
      scheduleTask(result.data);

      return c.json(result, 201);
    });
    ```
  - 原因: 创建成功后立即调用 `scheduleTask` 将新任务注册到 node-schedule；校验失败返回 400 + validation_error；创建成功返回 201

- [x] 实现 `GET /tasks/:id` — 获取任务详情
  - 位置: `POST /tasks` 之后
  - 关键逻辑:
    ```typescript
    /** GET /tasks/:id — Get task detail */
    app.get("/tasks/:id", sessionAuth, async (c) => {
      const user = c.get("user")!;
      const taskId = c.req.param("id")!;
      const result = await getTask(user.id, taskId);

      if (!result.success) {
        return c.json({ error: { type: "not_found", message: result.error.message } }, 404);
      }

      return c.json(result);
    });
    ```
  - 原因: `getTask` 内部校验 userId 所有权，不存在或越权均返回 NOT_FOUND → 404

- [x] 实现 `PUT /tasks/:id` — 更新任务配置
  - 位置: `GET /tasks/:id` 之后
  - 关键逻辑:
    ```typescript
    /** PUT /tasks/:id — Update task configuration */
    app.put("/tasks/:id", sessionAuth, async (c) => {
      const user = c.get("user")!;
      const taskId = c.req.param("id")!;
      const body = await c.req.json().catch(() => ({}));
      const result = await updateTask(user.id, taskId, body);

      if (!result.success) {
        if (result.error.code === "NOT_FOUND") {
          return c.json({ error: { type: "not_found", message: result.error.message } }, 404);
        }
        return c.json({ error: { type: "validation_error", message: result.error.message } }, 400);
      }

      // 更新成功后重新调度
      rescheduleTask(result.data);

      return c.json(result);
    });
    ```
  - 原因: 更新成功后调用 `rescheduleTask` 取消旧 cron Job 并注册新的；`rescheduleTask` 内部处理 enabled 状态判断（禁用任务不会注册调度）

- [x] 实现 `DELETE /tasks/:id` — 删除任务
  - 位置: `PUT /tasks/:id` 之后
  - 关键逻辑:
    ```typescript
    /** DELETE /tasks/:id — Delete a task */
    app.delete("/tasks/:id", sessionAuth, async (c) => {
      const user = c.get("user")!;
      const taskId = c.req.param("id")!;
      const result = await deleteTask(user.id, taskId);

      if (!result.success) {
        return c.json({ error: { type: "not_found", message: result.error.message } }, 404);
      }

      // 删除成功后取消调度
      unscheduleTask(taskId);

      return c.json(result);
    });
    ```
  - 原因: 删除成功后调用 `unscheduleTask` 取消 cron Job；与 `DELETE /api-keys/:id` 模式一致

- [x] 实现 `POST /tasks/:id/toggle` — 启用/禁用任务
  - 位置: `DELETE /tasks/:id` 之后
  - 关键逻辑:
    ```typescript
    /** POST /tasks/:id/toggle — Toggle task enabled/disabled */
    app.post("/tasks/:id/toggle", sessionAuth, async (c) => {
      const user = c.get("user")!;
      const taskId = c.req.param("id")!;
      const result = await toggleTask(user.id, taskId);

      if (!result.success) {
        return c.json({ error: { type: "not_found", message: result.error.message } }, 404);
      }

      // 根据 toggle 后的状态决定注册还是取消调度
      if (result.data.enabled) {
        // 切换为启用：需要获取完整任务数据来注册调度
        const taskResult = await getTask(user.id, taskId);
        if (taskResult.success) {
          scheduleTask(taskResult.data);
        }
      } else {
        unscheduleTask(taskId);
      }

      return c.json(result);
    });
    ```
  - 原因: toggle 后根据新状态分别处理——启用时需要完整任务数据（含 cron/url 等配置）注册调度，禁用时直接取消调度

- [x] 实现 `POST /tasks/:id/trigger` — 手动触发一次执行
  - 位置: `POST /tasks/:id/toggle` 之后
  - 关键逻辑:
    ```typescript
    /** POST /tasks/:id/trigger — Manually trigger a task execution */
    app.post("/tasks/:id/trigger", sessionAuth, async (c) => {
      const user = c.get("user")!;
      const taskId = c.req.param("id")!;
      const result = await triggerTask(user.id, taskId);

      if (!result.success) {
        return c.json({ error: { type: "not_found", message: result.error.message } }, 404);
      }

      return c.json(result);
    });
    ```
  - 原因: `triggerTask` 同步执行 HTTP 请求并返回执行结果（含 statusCode、responseBody、duration 等），前端可直接展示

- [x] 实现 `GET /tasks/:id/logs` — 获取执行历史（分页）
  - 位置: `POST /tasks/:id/trigger` 之后
  - 关键逻辑:
    ```typescript
    /** GET /tasks/:id/logs — Get execution logs (paginated) */
    app.get("/tasks/:id/logs", sessionAuth, async (c) => {
      const user = c.get("user")!;
      const taskId = c.req.param("id")!;

      // 先校验任务所有权
      const taskResult = await getTask(user.id, taskId);
      if (!taskResult.success) {
        return c.json({ error: { type: "not_found", message: "任务不存在" } }, 404);
      }

      const page = Math.max(1, Number(c.req.query("page")) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize")) || 20));
      const result = await listExecutionLogs(taskId, page, pageSize);

      return c.json(result);
    });
    ```
  - 原因: 先通过 `getTask` 校验所有权（非 owner 不能查看日志），再查询分页日志；`page` 和 `pageSize` 做范围限制防止异常值

- [x] 实现 `DELETE /tasks/:id/logs` — 清空执行历史
  - 位置: `GET /tasks/:id/logs` 之后
  - 关键逻辑:
    ```typescript
    /** DELETE /tasks/:id/logs — Clear all execution logs for a task */
    app.delete("/tasks/:id/logs", sessionAuth, async (c) => {
      const user = c.get("user")!;
      const taskId = c.req.param("id")!;

      // 先校验任务所有权
      const taskResult = await getTask(user.id, taskId);
      if (!taskResult.success) {
        return c.json({ error: { type: "not_found", message: "任务不存在" } }, 404);
      }

      const result = await clearExecutionLogs(taskId);
      return c.json(result);
    });
    ```
  - 原因: 先校验所有权再清空日志，防止越权操作

- [x] 添加 `export default app;`
  - 位置: 所有路由定义之后，文件末尾
  - 关键逻辑: `export default app;`
  - 原因: 与所有其他路由文件模式一致（`api-keys.ts`、`sessions.ts`、`environments.ts`）

- [x] 修改 `src/index.ts`，添加 tasks 路由的 import
  - 位置: 文件顶部 import 区域（~L18，`import webConfig from "./routes/web/config";` 之后）
  - 添加:
    ```typescript
    import webTasks from "./routes/web/tasks";
    ```
  - 原因: 与现有 import 模式一致，路由文件统一从 `./routes/web/` 导入

- [x] 修改 `src/index.ts`，挂载 tasks 路由
  - 位置: ~L75（`app.route("/web", webInstances);` 之后）
  - 添加:
    ```typescript
    app.route("/web", webTasks);
    ```
  - 原因: 挂载到 `/web` 前缀下，路由文件内定义的 `/tasks` 路径将映射为 `/web/tasks`；放在现有 web 路由之后保持代码整洁

- [x] 为 `tasks.ts` 路由编写单元测试
  - 测试文件: `src/__tests__/task-routes.test.ts`
  - 测试策略: 使用 `mock.module()` 模拟 `../../auth/middleware`（`sessionAuth` 设为直接调用 next 的 pass-through 中间件）、`../../services/task`（所有 CRUD 函数）、`../../services/scheduler`（`scheduleTask`、`unscheduleTask`、`rescheduleTask`）；使用 `app.fetch()` 直接调用路由进行 HTTP 级别测试
  - 测试场景:
    - **GET /web/tasks 列表**: mock `listTasks` 返回 `{ success: true, data: [...] }` → HTTP 200，响应体包含 `success: true` 和 `data` 数组
    - **GET /web/tasks 无认证**: 不设置 session cookie → HTTP 401，响应体包含 `error.type: "unauthorized"`
    - **POST /web/tasks 创建成功**: mock `createTask` 返回 `{ success: true, data: { id: "task_xxx", cron: "*/5 * * * *", ... } }` → HTTP 201，`scheduleTask` 被调用一次且参数包含正确的 cron
    - **POST /web/tasks 校验失败**: mock `createTask` 返回 `{ success: false, error: { code: "VALIDATION_ERROR", message: "..." } }` → HTTP 400，响应体包含 `error.type: "validation_error"`
    - **GET /web/tasks/:id 详情**: mock `getTask` 返回成功 → HTTP 200；mock 返回 NOT_FOUND → HTTP 404
    - **PUT /web/tasks/:id 更新成功**: mock `updateTask` 返回成功 → HTTP 200，`rescheduleTask` 被调用一次
    - **PUT /web/tasks/:id 不存在**: mock `updateTask` 返回 NOT_FOUND → HTTP 404，`rescheduleTask` 未被调用
    - **PUT /web/tasks/:id 校验失败**: mock `updateTask` 返回 VALIDATION_ERROR → HTTP 400
    - **DELETE /web/tasks/:id 删除成功**: mock `deleteTask` 返回成功 → HTTP 200，`unscheduleTask` 被调用一次且参数为 taskId
    - **DELETE /web/tasks/:id 不存在**: mock `deleteTask` 返回 NOT_FOUND → HTTP 404，`unscheduleTask` 未被调用
    - **POST /web/tasks/:id/toggle 启用**: mock `toggleTask` 返回 `{ data: { enabled: true } }` → HTTP 200，`scheduleTask` 被调用（通过 getTask 获取完整数据后）
    - **POST /web/tasks/:id/toggle 禁用**: mock `toggleTask` 返回 `{ data: { enabled: false } }` → HTTP 200，`unscheduleTask` 被调用
    - **POST /web/tasks/:id/toggle 不存在**: mock `toggleTask` 返回 NOT_FOUND → HTTP 404
    - **POST /web/tasks/:id/trigger 成功**: mock `triggerTask` 返回成功（含 statusCode、duration）→ HTTP 200
    - **POST /web/tasks/:id/trigger 不存在**: mock `triggerTask` 返回 NOT_FOUND → HTTP 404
    - **GET /web/tasks/:id/logs 分页**: mock `getTask` 返回成功，mock `listExecutionLogs` 返回分页数据 → HTTP 200，响应体包含 `data.total` 和 `data.items`
    - **GET /web/tasks/:id/logs 分页参数**: 传入 `?page=2&pageSize=10` → `listExecutionLogs` 被调用时 page=2, pageSize=10；传入 `?page=0` → page 被修正为 1；传入 `?pageSize=200` → pageSize 被截断为 100
    - **GET /web/tasks/:id/logs 无权访问**: mock `getTask` 返回 NOT_FOUND → HTTP 404，`listExecutionLogs` 未被调用
    - **DELETE /web/tasks/:id/logs 成功**: mock `getTask` 返回成功，mock `clearExecutionLogs` 返回成功 → HTTP 200
    - **DELETE /web/tasks/:id/logs 无权访问**: mock `getTask` 返回 NOT_FOUND → HTTP 404，`clearExecutionLogs` 未被调用
  - 运行命令: `bun test src/__tests__/task-routes.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 `tasks.ts` 文件存在且导出 Hono app
  - `grep 'export default' src/routes/web/tasks.ts`
  - 预期: 包含 `export default app;`

- [x] 验证所有 9 个路由端点已定义
  - `grep -c 'app\.\(get\|post\|put\|delete\).*"/tasks' src/routes/web/tasks.ts`
  - 预期: 计数 = 9（GET /tasks, POST /tasks, GET /tasks/:id, PUT /tasks/:id, DELETE /tasks/:id, POST /tasks/:id/toggle, POST /tasks/:id/trigger, GET /tasks/:id/logs, DELETE /tasks/:id/logs）

- [x] 验证所有端点使用 sessionAuth 中间件
  - `grep -c 'sessionAuth' src/routes/web/tasks.ts`
  - 预期: 计数 >= 9（每个端点一处）+ 1（import）

- [x] 验证 `src/index.ts` 包含 tasks 路由导入
  - `grep 'webTasks' src/index.ts`
  - 预期: 包含 import 行和 `app.route("/web", webTasks)` 行

- [x] 验证 `src/index.ts` 中 webTasks 挂载位置在现有 web 路由之后
  - `grep -n 'webInstances\|webTasks' src/index.ts`
  - 预期: `webTasks` 行号 > `webInstances` 行号

- [x] 验证调度函数调用点（创建后 scheduleTask、更新后 rescheduleTask、删除后 unscheduleTask）
  - `grep -c 'scheduleTask\|unscheduleTask\|rescheduleTask' src/routes/web/tasks.ts`
  - 预期: 计数 >= 5（1 处 import + 创建 1 + 更新 1 + 删除 1 + toggle 中 2）

- [x] 验证类型检查无新增错误
  - `bun run typecheck 2>&1 | grep -c 'error TS'`
  - 预期: 错误数不超过当前基线

- [x] 运行 Task 4 单元测试
  - `bun test src/__tests__/task-routes.test.ts`
  - 预期: 所有测试通过，无失败

---

### Task 5: 前端页面实现

**背景:**
为定时任务功能提供可视化管理界面。当前前端有仪表盘、模型、Agent、技能、MCP 等页面，但缺少定时任务管理入口。本 Task 新建 `TasksPage.tsx` 任务页面（任务列表 + 创建/编辑表单 + 执行历史面板），修改 `App.tsx` 添加侧边栏导航项和路由，修改 `client.ts` 添加所有 tasks API 方法。本 Task 依赖 Task 4 创建的 `/web/tasks` API 路由。

**涉及文件:**
- 新建: `web/src/pages/TasksPage.tsx`
- 修改: `web/src/api/client.ts` — 新增 tasks API 方法和类型定义
- 修改: `web/src/App.tsx` — 添加「定时任务」导航项、ViewId 类型、路由逻辑和组件渲染

**执行步骤:**

- [x] 在 `web/src/api/client.ts` 末尾添加 Tasks 相关类型定义和 API 函数
  - 位置: 文件末尾（`apiInspectMcpServer`/`apiListMcpTools` 函数之后）
  - 添加类型定义:
    ```typescript
    // --- Tasks ---

    export interface TaskInfo {
      id: string;
      userId: string;
      name: string;
      description: string | null;
      cron: string;
      timezone: string;
      enabled: boolean;
      url: string;
      method: string;
      headers: Record<string, string> | null;
      body: string | null;
      timeout: number;
      retryEnabled: boolean;
      retryCount: number;
      retryInterval: number;
      lastRunAt: number | null;
      nextRunAt: number | null;
      lastStatus: string | null;
      createdAt: number;
      updatedAt: number;
    }

    export interface ExecutionLogInfo {
      id: string;
      taskId: string;
      status: string;
      statusCode: number | null;
      responseBody: string | null;
      error: string | null;
      duration: number | null;
      attempt: number;
      triggeredBy: string;
      createdAt: number;
    }

    export interface PaginatedLogs {
      total: number;
      items: ExecutionLogInfo[];
    }
    ```
  - 添加 API 函数（沿用现有 `api<T>()` 模式，不使用 `apiConfigAction`，因为 tasks 是独立 REST 路由而非 config 路由）:
    ```typescript
    export function apiListTasks() {
      return api<{ success: true; data: TaskInfo[] }>("GET", "/web/tasks").then((r) => r.data);
    }

    export function apiCreateTask(data: Partial<TaskInfo>) {
      return api<{ success: true; data: TaskInfo }>("POST", "/web/tasks", data).then((r) => r.data);
    }

    export function apiGetTask(id: string) {
      return api<{ success: true; data: TaskInfo }>("GET", `/web/tasks/${id}`).then((r) => r.data);
    }

    export function apiUpdateTask(id: string, data: Partial<TaskInfo>) {
      return api<{ success: true; data: TaskInfo }>("PUT", `/web/tasks/${id}`, data).then((r) => r.data);
    }

    export function apiDeleteTask(id: string) {
      return api<void>("DELETE", `/web/tasks/${id}`);
    }

    export function apiToggleTask(id: string) {
      return api<{ success: true; data: { id: string; enabled: boolean } }>("POST", `/web/tasks/${id}/toggle`).then((r) => r.data);
    }

    export function apiTriggerTask(id: string) {
      return api<{ success: true; data: ExecutionLogInfo }>("POST", `/web/tasks/${id}/trigger`).then((r) => r.data);
    }

    export function apiListTaskLogs(id: string, page: number, pageSize: number) {
      return api<{ success: true; data: PaginatedLogs }>("GET", `/web/tasks/${id}/logs?page=${page}&pageSize=${pageSize}`).then((r) => r.data);
    }

    export function apiClearTaskLogs(id: string) {
      return api<void>("DELETE", `/web/tasks/${id}/logs`);
    }
    ```
  - 原因: 与现有 `apiFetchApiKeys`/`apiCreateApiKey`/`apiDeleteApiKey` 的直接 REST 调用模式一致；API 返回 `{ success, data }` 外壳，前端 `.then(r => r.data)` 解包简化使用

- [x] 修改 `web/src/App.tsx`，添加 lazy import
  - 位置: `McpPage` lazy import 之后（~L41）
  - 添加:
    ```typescript
    const TasksPage = lazy(() =>
        import("./pages/TasksPage").then((m) => ({ default: m.TasksPage })),
    );
    ```

- [x] 修改 `web/src/App.tsx`，添加 `Clock` 图标导入
  - 位置: lucide-react import 语句内（~L16-22）
  - 在 `KeyRound` 后追加 `Clock`:
    ```typescript
    import {
        LayoutDashboard,
        Cpu,
        Bot,
        Wrench,
        Plug,
        Clock,
        KeyRound,
    } from "lucide-react";
    ```

- [x] 修改 `web/src/App.tsx`，扩展 ViewId 类型和 configViews 数组
  - 位置: `type ViewId` 定义处（~L49-57）
  - 在 `"mcp"` 后追加 `| "tasks"`:
    ```typescript
    type ViewId =
        | "dashboard"
        | "session"
        | "apikeys"
        | "login"
        | "models"
        | "agents"
        | "skills"
        | "mcp"
        | "tasks";
    ```
  - 位置: `parseConfigView` 函数内的 `configViews` 数组（~L44）和 `parseRoute` 回调内的 `configViews` 数组（~L69）
  - 两处均在 `["models", "agents", "skills", "mcp"]` 末尾追加 `"tasks"`:
    ```typescript
    const configViews = ["models", "agents", "skills", "mcp", "tasks"];
    ```
  - 原因: `configViews` 在 `parseConfigView` 和 `parseRoute` 中各定义一次（局部数组），两处均需添加 `"tasks"` 以支持 `/code/tasks` 路径解析

- [x] 修改 `web/src/App.tsx`，在 navItems 数组中添加「定时任务」导航项
  - 位置: `navItems` 数组中 MCP 导航项（`id: "mcp"`）之后、API Key 导航项（`id: "apikeys"`）之前（~L173 之后）
  - 添加:
    ```typescript
    {
        id: "tasks",
        label: "定时任务",
        icon: <Clock className="h-4 w-4" />,
        active: activeView === "tasks",
        onClick: () => navigateToConfig("tasks"),
    },
    ```
  - 原因: 设计文档要求在 MCP 和 API Key 之间放置，与 `navigateToConfig` 模式一致

- [x] 修改 `web/src/App.tsx`，在渲染区域添加 TasksPage 条件
  - 位置: JSX 渲染区域（~L214-229），在 `configView === "mcp"` 分支之后
  - 将 `configView === "mcp" ? <McpPage /> : currentSessionId ?` 改为:
    ```tsx
    configView === "mcp" ? (
        <McpPage />
    ) : configView === "tasks" ? (
        <TasksPage />
    ) : currentSessionId ? (
    ```
  - 原因: 按现有三元链模式在 `mcp` 和 `currentSessionId` 之间插入 `tasks` 分支

- [x] 新建 `web/src/pages/TasksPage.tsx`，添加导入和类型定义
  - 位置: 文件开头
  - 导入（沿用 McpPage 模式）:
    ```typescript
    import { useState, useCallback, useEffect } from "react";
    import { toast } from "sonner";
    import { DataTable, type Column } from "@/components/config/DataTable";
    import { FormDialog } from "@/components/config/FormDialog";
    import { ConfirmDialog } from "@/components/config/ConfirmDialog";
    import { StatusBadge } from "@/components/config/StatusBadge";
    import { Skeleton } from "@/components/ui/skeleton";
    import { Button } from "@/components/ui/button";
    import { Input } from "@/components/ui/input";
    import { Label } from "@/components/ui/label";
    import {
      Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
    } from "@/components/ui/select";
    import { Switch } from "@/components/ui/switch";
    import {
      apiListTasks, apiCreateTask, apiGetTask, apiUpdateTask,
      apiDeleteTask, apiToggleTask, apiTriggerTask,
      apiListTaskLogs, apiClearTaskLogs,
    } from "../api/client";
    import type { TaskInfo, ExecutionLogInfo, PaginatedLogs } from "../api/client";
    ```
  - 常用 cron 快捷选项常量:
    ```typescript
    const CRON_PRESETS = [
      { label: "每 5 分钟", value: "*/5 * * * *" },
      { label: "每小时", value: "0 * * * *" },
      { label: "每天早 9 点", value: "0 9 * * *" },
      { label: "工作日早 9 点", value: "0 9 * * 1-5" },
      { label: "每月 1 号", value: "0 0 1 * *" },
    ];
    ```
  - 键值对列表项类型（与 McpPage 中 `KeyValueEntry` 一致）:
    ```typescript
    type KeyValueEntry = { key: string; value: string };
    ```
  - 原因: 导入路径和组件使用模式与 `McpPage.tsx` 完全一致；`Switch` 组件用于重试启用开关；`KeyValueEntry` 用于 Headers 编辑器

- [x] 在 `TasksPage.tsx` 添加表单校验函数和辅助函数
  - 位置: 导入和类型定义之后，`TasksPage` 组件函数之前
  - `validateTaskForm` 校验函数:
    ```typescript
    function validateTaskForm(name: string, url: string, cron: string): string | null {
      if (!name.trim()) return "任务名称不能为空";
      if (name.length > 128) return "任务名称不能超过 128 字符";
      if (!url.trim()) return "URL 不能为空";
      if (!/^https?:\/\//.test(url)) return "URL 必须以 http:// 或 https:// 开头";
      if (!cron.trim()) return "cron 表达式不能为空";
      const parts = cron.trim().split(/\s+/);
      if (parts.length !== 5) return "cron 表达式必须为 5 字段（分 时 日 月 周）";
      return null;
    }
    ```
  - 时间戳格式化辅助:
    ```typescript
    function formatTimestamp(ts: number | null): string {
      if (!ts) return "—";
      return new Date(ts * 1000).toLocaleString("zh-CN", {
        month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    }
    ```
  - 耗时格式化辅助:
    ```typescript
    function formatDuration(ms: number | null): string {
      if (ms == null) return "—";
      if (ms < 1000) return `${ms}ms`;
      return `${(ms / 1000).toFixed(2)}s`;
    }
    ```
  - 原因: 校验函数与服务端 `validateTaskInput` 保持一致的规则（前端快速反馈，后端兜底）；格式化函数统一展示时间戳和耗时

- [ ] 在 `TasksPage.tsx` 实现 `TasksPage` 组件 — 状态声明
  - 位置: `export function TasksPage()` 函数开头
  - 状态管理（沿用 McpPage 的 `useState` 模式）:
    ```typescript
    export function TasksPage() {
      // --- 列表数据 ---
      const [tasks, setTasks] = useState<TaskInfo[]>([]);
      const [loading, setLoading] = useState(true);

      // --- 对话框控制 ---
      const [dialogOpen, setDialogOpen] = useState(false);
      const [editingTask, setEditingTask] = useState<TaskInfo | null>(null);
      const [confirmOpen, setConfirmOpen] = useState(false);
      const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

      // --- 执行历史面板 ---
      const [logsTaskId, setLogsTaskId] = useState<string | null>(null);
      const [logs, setLogs] = useState<ExecutionLogInfo[]>([]);
      const [logsTotal, setLogsTotal] = useState(0);
      const [logsPage, setLogsPage] = useState(1);
      const [logsLoading, setLogsLoading] = useState(false);
      const [logsDialogOpen, setLogsDialogOpen] = useState(false);
      const [clearLogsConfirmOpen, setClearLogsConfirmOpen] = useState(false);
      const [responseDialogOpen, setResponseDialogOpen] = useState(false);
      const [selectedResponse, setSelectedResponse] = useState<string | null>(null);

      // --- 表单字段（新建/编辑共用） ---
      const [formName, setFormName] = useState("");
      const [formDescription, setFormDescription] = useState("");
      const [formCron, setFormCron] = useState("*/5 * * * *");
      const [formTimezone, setFormTimezone] = useState("UTC");
      const [formUrl, setFormUrl] = useState("");
      const [formMethod, setFormMethod] = useState("GET");
      const [formHeaders, setFormHeaders] = useState<KeyValueEntry[]>([{ key: "", value: "" }]);
      const [formBody, setFormBody] = useState("");
      const [formTimeout, setFormTimeout] = useState("30000");
      const [formRetryEnabled, setFormRetryEnabled] = useState(false);
      const [formRetryCount, setFormRetryCount] = useState("3");
      const [formRetryInterval, setFormRetryInterval] = useState("60");
      const [formSaving, setFormSaving] = useState(false);
      const [triggeringTaskId, setTriggeringTaskId] = useState<string | null>(null);
      ...
    ```
  - 原因: 所有状态变量命名遵循 `form` 前缀 + 字段名的 CLAUDE.md 约定；执行历史使用独立 Dialog 展示而非 expandableRow（因为历史数据需要分页加载），避免任务列表嵌套过深

- [x] 在 `TasksPage` 组件实现数据加载和操作回调函数
  - 位置: 状态声明之后
  - `loadTasks` 加载任务列表:
    ```typescript
    const loadTasks = useCallback(async () => {
      setLoading(true);
      try {
        const data = await apiListTasks();
        setTasks(data);
      } catch (e) {
        toast.error("加载任务列表失败: " + (e instanceof Error ? e.message : "未知错误"));
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => { loadTasks(); }, [loadTasks]);
    ```
  - `loadLogs` 加载执行历史:
    ```typescript
    const loadLogs = useCallback(async (taskId: string, page = 1) => {
      setLogsLoading(true);
      try {
        const data = await apiListTaskLogs(taskId, page, 20);
        setLogs(data.items);
        setLogsTotal(data.total);
        setLogsPage(page);
      } catch (e) {
        toast.error("加载执行历史失败: " + (e instanceof Error ? e.message : "未知错误"));
      } finally {
        setLogsLoading(false);
      }
    }, []);
    ```
  - `handleOpenCreate` 打开新建表单:
    ```typescript
    const handleOpenCreate = () => {
      setEditingTask(null);
      setFormName("");
      setFormDescription("");
      setFormCron("*/5 * * * *");
      setFormTimezone("UTC");
      setFormUrl("");
      setFormMethod("GET");
      setFormHeaders([{ key: "", value: "" }]);
      setFormBody("");
      setFormTimeout("30000");
      setFormRetryEnabled(false);
      setFormRetryCount("3");
      setFormRetryInterval("60");
      setDialogOpen(true);
    };
    ```
  - `handleOpenEdit` 打开编辑表单（从 API 获取完整数据填充表单）:
    ```typescript
    const handleOpenEdit = async (task: TaskInfo) => {
      setEditingTask(task);
      setFormName(task.name);
      setFormDescription(task.description ?? "");
      setFormCron(task.cron);
      setFormTimezone(task.timezone);
      setFormUrl(task.url);
      setFormMethod(task.method);
      setFormHeaders(
        task.headers && Object.keys(task.headers).length > 0
          ? Object.entries(task.headers).map(([key, value]) => ({ key, value }))
          : [{ key: "", value: "" }]
      );
      setFormBody(task.body ?? "");
      setFormTimeout(String(task.timeout));
      setFormRetryEnabled(task.retryEnabled);
      setFormRetryCount(String(task.retryCount));
      setFormRetryInterval(String(task.retryInterval));
      setDialogOpen(true);
    };
    ```
  - `handleSave` 保存表单:
    ```typescript
    const handleSave = async () => {
      const err = validateTaskForm(formName, formUrl, formCron);
      if (err) { toast.error(err); return; }
      setFormSaving(true);
      try {
        const headersObj: Record<string, string> | null =
          formHeaders.filter((h) => h.key.trim()).length > 0
            ? Object.fromEntries(formHeaders.filter((h) => h.key.trim()).map((h) => [h.key, h.value]))
            : null;
        const payload: Partial<TaskInfo> = {
          name: formName,
          description: formDescription || null,
          cron: formCron,
          timezone: formTimezone,
          url: formUrl,
          method: formMethod,
          headers: headersObj,
          body: ["POST", "PUT", "PATCH"].includes(formMethod) && formBody.trim() ? formBody.trim() : null,
          timeout: parseInt(formTimeout, 10) || 30000,
          retryEnabled: formRetryEnabled,
          retryCount: parseInt(formRetryCount, 10) || 3,
          retryInterval: parseInt(formRetryInterval, 10) || 60,
        };
        if (editingTask) {
          await apiUpdateTask(editingTask.id, payload);
          toast.success("任务已更新");
        } else {
          await apiCreateTask(payload);
          toast.success("任务已创建");
        }
        setDialogOpen(false);
        loadTasks();
      } catch (e) {
        toast.error("保存失败: " + (e instanceof Error ? e.message : "未知错误"));
      } finally {
        setFormSaving(false);
      }
    };
    ```
  - `handleToggle` 启用/禁用切换:
    ```typescript
    const handleToggle = async (task: TaskInfo) => {
      try {
        await apiToggleTask(task.id);
        toast.success(task.enabled ? `已禁用 "${task.name}"` : `已启用 "${task.name}"`);
        loadTasks();
      } catch (e) {
        toast.error("操作失败: " + (e instanceof Error ? e.message : "未知错误"));
      }
    };
    ```
  - `handleTrigger` 手动触发:
    ```typescript
    const handleTrigger = async (task: TaskInfo) => {
      setTriggeringTaskId(task.id);
      try {
        const result = await apiTriggerTask(task.id);
        toast.success(`任务已触发，状态: ${result.status}，耗时: ${formatDuration(result.duration)}`);
        loadTasks();
      } catch (e) {
        toast.error("触发失败: " + (e instanceof Error ? e.message : "未知错误"));
      } finally {
        setTriggeringTaskId(null);
      }
    };
    ```
  - `confirmDelete` 确认删除:
    ```typescript
    const confirmDelete = async () => {
      if (!deleteTarget) return;
      try {
        await apiDeleteTask(deleteTarget);
        toast.success("任务已删除");
        setConfirmOpen(false);
        loadTasks();
      } catch (e) {
        toast.error("删除失败: " + (e instanceof Error ? e.message : "未知错误"));
      }
    };
    ```
  - `handleViewLogs` 查看执行历史:
    ```typescript
    const handleViewLogs = (task: TaskInfo) => {
      setLogsTaskId(task.id);
      setLogsDialogOpen(true);
      loadLogs(task.id, 1);
    };
    ```
  - `confirmClearLogs` 清空执行历史:
    ```typescript
    const confirmClearLogs = async () => {
      if (!logsTaskId) return;
      try {
        await apiClearTaskLogs(logsTaskId);
        toast.success("执行历史已清空");
        setClearLogsConfirmOpen(false);
        loadLogs(logsTaskId, 1);
      } catch (e) {
        toast.error("清空失败: " + (e instanceof Error ? e.message : "未知错误"));
      }
    };
    ```
  - `handleViewResponse` 查看响应体:
    ```typescript
    const handleViewResponse = (responseBody: string | null) => {
      setSelectedResponse(responseBody);
      setResponseDialogOpen(true);
    };
    ```
  - 原因: 所有回调函数遵循 McpPage 的模式——`try-catch + toast 错误提示 + finally 清理 loading 状态`；`handleSave` 中 headers/body 的组装逻辑与 McpPage 中 `buildMcpPayload` 的 `KeyValueEntry → Object` 转换一致

- [x] 在 `TasksPage` 组件定义任务列表的 DataTable columns
  - 位置: 回调函数之后，`if (loading)` 之前
  - 列定义:
    ```typescript
    const columns: Column<TaskInfo>[] = [
      {
        key: "name",
        header: "名称",
        sortable: true,
        filterable: true,
      },
      {
        key: "cron",
        header: "Cron 表达式",
        render: (row) => (
          <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{row.cron}</code>
        ),
      },
      {
        key: "method",
        header: "请求",
        render: (row) => (
          <span className="text-xs">
            <span className="font-semibold text-blue-600">{row.method}</span>{" "}
            <span className="text-muted-foreground truncate max-w-[200px] inline-block align-bottom" title={row.url}>
              {row.url.replace(/^https?:\/\//, "").split("/")[0]}
            </span>
          </span>
        ),
      },
      {
        key: "enabled",
        header: "状态",
        filterable: true,
        render: (row) => <StatusBadge status={row.enabled ? "enabled" : "disabled"} />,
      },
      {
        key: "lastRunAt",
        header: "上次执行",
        sortable: true,
        render: (row) => (
          <div className="text-xs">
            {formatTimestamp(row.lastRunAt)}
            {row.lastStatus && (
              <StatusBadge
                status={row.lastStatus === "success" ? "enabled" : row.lastStatus === "failed" ? "disabled" : row.lastStatus}
              />
            )}
          </div>
        ),
      },
      {
        key: "nextRunAt",
        header: "下次执行",
        render: (row) => <span className="text-xs">{formatTimestamp(row.nextRunAt)}</span>,
      },
    ];
    ```
  - 原因: 列定义复用 `StatusBadge`（`enabled`/`disabled` 映射到绿/灰色），`lastStatus` 映射 `success→enabled`(绿)、`failed→disabled`(灰)；URL 截断显示主机名避免列过宽

- [x] 在 `TasksPage` 组件实现 JSX 渲染 — 加载骨架屏 + 任务列表
  - 位置: `if (loading)` 条件渲染至 DataTable
  - 加载骨架屏（与 McpPage 一致）:
    ```tsx
    if (loading) {
      return (
        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-9 w-24" />
          </div>
          <div className="rounded-md border">
            <Skeleton className="h-10 w-full rounded-t-md" />
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-none border-t" />
            ))}
          </div>
        </div>
      );
    }
    ```
  - 任务列表主体:
    ```tsx
    return (
      <div className="h-full overflow-y-auto p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">定时任务管理</h2>
          <Button onClick={handleOpenCreate}>新建任务</Button>
        </div>
        <DataTable<TaskInfo>
          columns={columns}
          data={tasks}
          searchable
          searchPlaceholder="搜索任务..."
          rowKey={(row) => row.id}
          actions={(row) => (
            <div className="flex gap-2">
              <Button size="sm" variant="outline"
                disabled={triggeringTaskId === row.id}
                onClick={() => handleTrigger(row)}>
                {triggeringTaskId === row.id ? "触发中..." : "手动触发"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleViewLogs(row)}>
                执行历史
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleToggle(row)}>
                {row.enabled ? "禁用" : "启用"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleOpenEdit(row)}>编辑</Button>
              <Button size="sm" variant="destructive"
                onClick={() => { setDeleteTarget(row.id); setConfirmOpen(true); }}>删除</Button>
            </div>
          )}
        />
    ```
  - 原因: 行操作包含手动触发、执行历史、启用/禁用、编辑、删除五个按钮，与设计文档要求一致；按钮排列顺序按操作频率从高到低

- [x] 在 `TasksPage` JSX 渲染 — 创建/编辑 FormDialog
  - 位置: `</DataTable>` 之后、删除确认对话框之前
  - FormDialog 包含四块内容——基本信息、调度配置、HTTP 配置、重试配置:
    ```tsx
    <FormDialog
      open={dialogOpen}
      onOpenChange={setDialogOpen}
      title={editingTask ? "编辑定时任务" : "新建定时任务"}
      onSubmit={handleSave}
      loading={formSaving}
      width="sm:max-w-2xl">
      <div className="space-y-4">
        {/* 基本信息 */}
        <div>
          <Label>名称 *</Label>
          <Input value={formName} onChange={(e) => setFormName(e.target.value)}
            placeholder="例如：每日健康检查" />
        </div>
        <div>
          <Label>描述</Label>
          <Input value={formDescription} onChange={(e) => setFormDescription(e.target.value)}
            placeholder="可选的任务描述" />
        </div>

        {/* 调度配置 */}
        <div className="border-t pt-4">
          <h3 className="text-sm font-medium mb-2">调度配置</h3>
          <div className="space-y-2">
            <div>
              <Label>Cron 表达式 *</Label>
              <Input value={formCron} onChange={(e) => setFormCron(e.target.value)}
                placeholder="*/5 * * * *" className="font-mono" />
              <div className="flex flex-wrap gap-1 mt-1">
                {CRON_PRESETS.map((preset) => (
                  <button key={preset.value} type="button"
                    className="text-xs px-2 py-0.5 rounded border hover:bg-muted"
                    onClick={() => setFormCron(preset.value)}>
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <Label>时区</Label>
              <Select value={formTimezone} onValueChange={setFormTimezone}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="UTC">UTC</SelectItem>
                  <SelectItem value="Asia/Shanghai">Asia/Shanghai (CST)</SelectItem>
                  <SelectItem value="America/New_York">America/New_York (EST)</SelectItem>
                  <SelectItem value="Europe/London">Europe/London (GMT)</SelectItem>
                  <SelectItem value="Asia/Tokyo">Asia/Tokyo (JST)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* HTTP 配置 */}
        <div className="border-t pt-4">
          <h3 className="text-sm font-medium mb-2">HTTP 配置</h3>
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label>方法</Label>
                <Select value={formMethod} onValueChange={setFormMethod}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="GET">GET</SelectItem>
                    <SelectItem value="POST">POST</SelectItem>
                    <SelectItem value="PUT">PUT</SelectItem>
                    <SelectItem value="DELETE">DELETE</SelectItem>
                    <SelectItem value="PATCH">PATCH</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2">
                <Label>URL *</Label>
                <Input value={formUrl} onChange={(e) => setFormUrl(e.target.value)}
                  placeholder="https://api.example.com/health" />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>请求头</Label>
                <Button type="button" size="sm" variant="outline"
                  onClick={() => setFormHeaders([...formHeaders, { key: "", value: "" }])}>
                  添加
                </Button>
              </div>
              {formHeaders.map((entry, idx) => (
                <div key={idx} className="flex gap-2 mb-2 items-center">
                  <Input placeholder="Header Name" value={entry.key}
                    onChange={(e) => {
                      const next = [...formHeaders];
                      next[idx] = { ...next[idx], key: e.target.value };
                      setFormHeaders(next);
                    }} className="flex-1" />
                  <Input placeholder="Header Value" value={entry.value}
                    onChange={(e) => {
                      const next = [...formHeaders];
                      next[idx] = { ...next[idx], value: e.target.value };
                      setFormHeaders(next);
                    }} className="flex-1" />
                  <Button type="button" size="sm" variant="ghost"
                    onClick={() => setFormHeaders(formHeaders.filter((_, i) => i !== idx))}>
                    删除
                  </Button>
                </div>
              ))}
            </div>
            {["POST", "PUT", "PATCH"].includes(formMethod) && (
              <div>
                <Label>请求体 (JSON)</Label>
                <textarea
                  className="w-full min-h-[80px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                  value={formBody}
                  onChange={(e) => setFormBody(e.target.value)}
                  placeholder='{"key": "value"}' />
              </div>
            )}
            <div>
              <Label>超时时间 (ms)</Label>
              <Input type="number" value={formTimeout}
                onChange={(e) => setFormTimeout(e.target.value)}
                placeholder="30000" min={1000} max={300000} />
            </div>
          </div>
        </div>

        {/* 重试配置 */}
        <div className="border-t pt-4">
          <h3 className="text-sm font-medium mb-2">重试配置</h3>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Switch checked={formRetryEnabled}
                onCheckedChange={setFormRetryEnabled} />
              <Label>启用自动重试</Label>
            </div>
            {formRetryEnabled && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>重试次数</Label>
                  <Input type="number" value={formRetryCount}
                    onChange={(e) => setFormRetryCount(e.target.value)}
                    placeholder="3" min={1} max={10} />
                </div>
                <div>
                  <Label>重试间隔 (秒)</Label>
                  <Input type="number" value={formRetryInterval}
                    onChange={(e) => setFormRetryInterval(e.target.value)}
                    placeholder="60" min={10} max={3600} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </FormDialog>
    ```
  - 原因: 表单分四个区域用 `border-t` 分隔，与设计文档要求的分组一致；Headers 编辑器复用 McpPage 的 `KeyValueEntry` 动态增删行模式；Body 使用原生 `<textarea>` 而非 Input 以支持多行 JSON 编辑；Cron 快捷选项使用 `<button>` 标签点击直接填入；Switch 组件用于重试启用开关

- [x] 在 `TasksPage` JSX 渲染 — 删除确认、执行历史、响应体查看、清空确认对话框
  - 位置: FormDialog 之后，`</div>` 根元素闭合之前
  - 删除确认:
    ```tsx
    <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen}
      title="确认删除" description="此操作不可逆。确定要删除这个定时任务吗？所有执行历史也将被删除。"
      variant="destructive" onConfirm={confirmDelete} />
    ```
  - 执行历史 Dialog:
    ```tsx
    <FormDialog open={logsDialogOpen} onOpenChange={setLogsDialogOpen}
      title="执行历史" onSubmit={() => {}} width="sm:max-w-3xl">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">共 {logsTotal} 条记录</span>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive"
              onClick={() => setClearLogsConfirmOpen(true)}
              disabled={logsTotal === 0}>
              清空历史
            </Button>
          </div>
        </div>
        {logsLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : logs.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center">暂无执行记录</div>
        ) : (
          <div className="rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left">时间</th>
                  <th className="px-3 py-2 text-left">状态</th>
                  <th className="px-3 py-2 text-left">状态码</th>
                  <th className="px-3 py-2 text-left">耗时</th>
                  <th className="px-3 py-2 text-left">触发方式</th>
                  <th className="px-3 py-2 text-left">操作</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="border-b last:border-0 hover:bg-muted/20">
                    <td className="px-3 py-2 text-xs">{formatTimestamp(log.createdAt)}</td>
                    <td className="px-3 py-2">
                      <StatusBadge
                        status={log.status === "success" ? "enabled" : log.status === "failed" ? "disabled" : log.status}
                      />
                    </td>
                    <td className="px-3 py-2 text-xs font-mono">{log.statusCode ?? "—"}</td>
                    <td className="px-3 py-2 text-xs">{formatDuration(log.duration)}</td>
                    <td className="px-3 py-2 text-xs">{log.triggeredBy}</td>
                    <td className="px-3 py-2">
                      {log.responseBody && (
                        <Button size="sm" variant="outline"
                          onClick={() => handleViewResponse(log.responseBody)}>
                          查看响应
                        </Button>
                      )}
                      {log.error && (
                        <span className="text-xs text-destructive" title={log.error}>错误</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {logsTotal > 20 && (
          <div className="flex items-center justify-between">
            <Button size="sm" variant="outline"
              disabled={logsPage <= 1}
              onClick={() => logsTaskId && loadLogs(logsTaskId, logsPage - 1)}>
              上一页
            </Button>
            <span className="text-sm text-muted-foreground">
              第 {logsPage} 页，共 {Math.ceil(logsTotal / 20)} 页
            </span>
            <Button size="sm" variant="outline"
              disabled={logsPage >= Math.ceil(logsTotal / 20)}
              onClick={() => logsTaskId && loadLogs(logsTaskId, logsPage + 1)}>
              下一页
            </Button>
          </div>
        )}
      </div>
    </FormDialog>
    ```
  - 响应体查看 Dialog:
    ```tsx
    <FormDialog open={responseDialogOpen} onOpenChange={setResponseDialogOpen}
      title="响应体" onSubmit={() => {}} width="sm:max-w-2xl">
      <pre className="text-xs bg-muted p-4 rounded overflow-auto max-h-[400px] whitespace-pre-wrap break-all">
        {(() => {
          try { return selectedResponse ? JSON.stringify(JSON.parse(selectedResponse), null, 2) : "无内容"; }
          catch { return selectedResponse ?? "无内容"; }
        })()}
      </pre>
    </FormDialog>
    ```
  - 清空执行历史确认:
    ```tsx
    <ConfirmDialog open={clearLogsConfirmOpen} onOpenChange={setClearLogsConfirmOpen}
      title="确认清空" description="此操作不可逆。确定要清空所有执行历史吗？"
      variant="destructive" onConfirm={confirmClearLogs} />
    ```
  - 根元素闭合:
    ```tsx
      </div>
    );
    }
    ```
  - 原因: 执行历史使用独立 FormDialog（复用 FormDialog 组件的弹窗框架，`onSubmit={() => {}}` 禁用提交按钮行为），内含原生 `<table>` 展示日志记录；分页在总记录超过 20 条时显示；响应体尝试 JSON 美化后展示，解析失败则原样显示

- [x] 构建前端代码验证编译通过
  - 执行命令: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web`
  - 原因: 根据 CLAUDE.md，后端通过 `serveStatic` 挂载 `web/dist/`，前端代码修改后必须执行 `bun run build:web` 重新构建才能生效

- [x] 为 `TasksPage` 前端组件编写单元测试
  - 测试文件: `web/src/__tests__/tasks-page.test.ts`
  - 测试策略: 使用 `import.meta.dirname` 解析文件路径（遵循 CLAUDE.md 前端测试规范），测试导出函数、校验逻辑和常量定义
  - 测试场景:
    - **validateTaskForm 校验**: name 为空 → 返回 "任务名称不能为空"；url 非 http/https → 返回 "URL 必须以 http:// 或 https:// 开头"；cron 为空 → 返回 "cron 表达式不能为空"；cron 非 5 字段 `"0 * * * * *"` → 返回 "cron 表达式必须为 5 字段"；全部合法 → 返回 null
    - **formatTimestamp 格式化**: `null` → 返回 `"—"`；有效 Unix 时间戳 → 返回非空字符串，包含数字
    - **formatDuration 格式化**: `null` → 返回 `"—"`；`500` → 返回 `"500ms"`；`1500` → 返回 `"1.50s"`
    - **CRON_PRESETS 常量**: 验证长度为 5，每项包含 `label` 和 `value`，value 均为 5 字段 cron
    - **TasksPage 组件导出**: 验证 `import { TasksPage }` 成功，`TasksPage` 为函数组件
    - **client.ts tasks API 函数导出**: 验证 `apiListTasks`、`apiCreateTask`、`apiGetTask`、`apiUpdateTask`、`apiDeleteTask`、`apiToggleTask`、`apiTriggerTask`、`apiListTaskLogs`、`apiClearTaskLogs` 均为函数
    - **TaskInfo 类型导出**: 验证 `import type { TaskInfo, ExecutionLogInfo, PaginatedLogs }` 成功
  - 运行命令: `bun test web/src/__tests__/tasks-page.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 `client.ts` 包含所有 tasks API 函数
  - `grep -c 'apiListTasks\|apiCreateTask\|apiGetTask\|apiUpdateTask\|apiDeleteTask\|apiToggleTask\|apiTriggerTask\|apiListTaskLogs\|apiClearTaskLogs' web/src/api/client.ts`
  - 预期: 计数 >= 9（每个函数名各出现一次定义 + 多次导出引用）

- [x] 验证 `client.ts` 包含 Tasks 相关类型定义
  - `grep -c 'export interface TaskInfo\|export interface ExecutionLogInfo\|export interface PaginatedLogs' web/src/api/client.ts`
  - 预期: 计数 = 3

- [x] 验证 `App.tsx` 包含 TasksPage lazy import
  - `grep 'TasksPage' web/src/App.tsx`
  - 预期: 包含 `lazy(() => import("./pages/TasksPage"))` 和 `<TasksPage />`

- [x] 验证 `App.tsx` 包含 Clock 图标导入
  - `grep 'Clock' web/src/App.tsx`
  - 预期: 包含 `Clock` 在 lucide-react import 中和 `<Clock className` 在 navItem 中

- [x] 验证 `App.tsx` ViewId 类型包含 tasks
  - `grep '"tasks"' web/src/App.tsx`
  - 预期: 在 ViewId 类型、configViews 数组（两处）和渲染条件中均出现

- [x] 验证 `App.tsx` navItems 包含「定时任务」项
  - `grep '定时任务' web/src/App.tsx`
  - 预期: 包含 `label: "定时任务"` 的导航项定义

- [x] 验证 `TasksPage.tsx` 文件存在且导出组件
  - `grep 'export function TasksPage' web/src/pages/TasksPage.tsx`
  - 预期: 存在导出行

- [x] 验证 `TasksPage.tsx` 包含 DataTable、FormDialog、StatusBadge 使用
  - `grep -c 'DataTable\|FormDialog\|StatusBadge\|ConfirmDialog' web/src/pages/TasksPage.tsx`
  - 预期: 计数 >= 4（每个组件至少一处引用）

- [x] 验证 `TasksPage.tsx` 包含 cron 快捷选项
  - `grep -c 'CRON_PRESETS' web/src/pages/TasksPage.tsx`
  - 预期: 计数 >= 2（定义和使用各一处）

- [x] 验证 `TasksPage.tsx` 包含 Headers Key-Value 编辑器
  - `grep -c 'KeyValueEntry\|formHeaders' web/src/pages/TasksPage.tsx`
  - 预期: 计数 >= 4（类型定义、状态声明、添加按钮、渲染列表）

- [x] 验证 `TasksPage.tsx` 包含重试配置区域
  - `grep -c 'formRetryEnabled\|formRetryCount\|formRetryInterval' web/src/pages/TasksPage.tsx`
  - 预期: 计数 >= 6（每个字段至少 2 处：状态声明和 JSX 渲染）

- [x] 验证 `TasksPage.tsx` 包含执行历史面板
  - `grep -c 'logsDialogOpen\|apiListTaskLogs\|apiClearTaskLogs' web/src/pages/TasksPage.tsx`
  - 预期: 计数 >= 4（状态声明 + API 调用）

- [x] 验证前端构建成功
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -5`
  - 预期: 输出包含 "built in" 且无 error

- [x] 验证类型检查无新增错误
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | grep -c 'error TS'`
  - 预期: 错误数不超过当前基线（约 2 个已有错误）

- [x] 运行 Task 5 前端单元测试
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/tasks-page.test.ts`
  - 预期: 所有测试通过，无失败

---

### Task 6: 定时 HTTP 任务功能验收

**前置条件:**
- 后端所有 Task（1-4）代码已实现
- 前端 Task 5 代码已实现且 `bun run build:web` 构建成功
- 数据库文件存在（`data/rcs.db`）
- 有至少一个测试用户（可通过 better-auth 注册或使用系统用户）

**检查步骤:**

- [x] 运行完整后端测试套件确保无回归
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/ 2>&1 | tail -20`
  - 预期: 全部测试通过（已知 mock 隔离问题导致的 middleware.test.ts 和 routes.test.ts 除外）

- [ ] 验证 SQLite 表创建成功
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun -e "const db = new (require('bun:sqlite').Database)('data/rcs.db'); const tables = db.query(\"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('scheduled_task','task_execution_log')\").all(); console.log(tables); db.close()" 2>/dev/null || sqlite3 data/rcs.db ".tables" 2>/dev/null | grep -c 'scheduled_task'`
  - 预期: `scheduled_task` 和 `task_execution_log` 两张表存在

- [ ] 验证 API 路由可访问（需认证）
  - `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/web/tasks`
  - 预期: 返回 401（未认证），不返回 404

- [ ] 验证任务创建和列表 API（需启动服务并认证）
  - 启动服务: `bun run dev`
  - 通过前端 UI 或 curl（带 session cookie）创建任务:
    ```
    curl -s -X POST http://localhost:3000/web/tasks \
      -H 'Content-Type: application/json' \
      -b 'session_cookie=xxx' \
      -d '{"name":"测试任务","cron":"*/5 * * * *","url":"https://httpbin.org/get","method":"GET"}'
    ```
  - 预期: 返回 `{ success: true, data: { id: "task_xxx", ... } }`

- [ ] 验证任务列表页面可访问
  - 浏览器访问 `http://localhost:3000/code/tasks`
  - 预期: 显示定时任务页面，包含 DataTable 和「创建任务」按钮

- [ ] 验证调度引擎启动和执行
  - 创建一个每分钟执行的任务（cron: `* * * * *`，URL: `https://httpbin.org/get`）
  - 等待 1 分钟后检查执行日志:
    ```
    curl -s http://localhost:3000/web/tasks/{task_id}/logs \
      -b 'session_cookie=xxx'
    ```
  - 预期: 返回至少一条执行记录，status 为 "success" 或 "failed"

- [ ] 验证手动触发功能
  - `curl -s -X POST http://localhost:3000/web/tasks/{task_id}/trigger -b 'session_cookie=xxx'`
  - 预期: 返回执行记录，triggeredBy 为 "manual"

- [ ] 验证任务启用/禁用切换
  - 禁用任务: `curl -s -X POST http://localhost:3000/web/tasks/{task_id}/toggle -b 'session_cookie=xxx'`
  - 预期: 返回 `{ success: true, data: { enabled: false } }`
  - 再次切换启用: `curl -s -X POST http://localhost:3000/web/tasks/{task_id}/toggle -b 'session_cookie=xxx'`
  - 预期: 返回 `{ success: true, data: { enabled: true } }`

- [ ] 验证执行历史分页和清空
  - 手动触发任务多次（至少 3 次）以产生执行日志
  - 查询分页日志: `curl -s "http://localhost:3000/web/tasks/{task_id}/logs?page=1&pageSize=2" -b 'session_cookie=xxx'`
  - 预期: 返回 `{ success: true, data: { total: N, items: [2条记录] } }`
  - 清空日志: `curl -s -X DELETE http://localhost:3000/web/tasks/{task_id}/logs -b 'session_cookie=xxx'`
  - 预期: 返回 `{ success: true }`，再次查询日志 total 为 0

- [ ] 验证失败自动重试功能
  - 创建一个会失败的任务（URL: `https://httpbin.org/status/500`，retryEnabled: true，retryCount: 2，retryInterval: 10）
  - 手动触发: `curl -s -X POST http://localhost:3000/web/tasks/{task_id}/trigger -b 'session_cookie=xxx'`
  - 等待 30 秒后检查日志:
    ```
    curl -s "http://localhost:3000/web/tasks/{task_id}/logs" -b 'session_cookie=xxx'
    ```
  - 预期: 日志中有 status="retrying" 的重试记录

- [ ] 验证服务重启后调度恢复
  - 创建一个每分钟执行的启用任务
  - 重启服务: 停止后重新 `bun run dev`
  - 等待 1 分钟后检查执行日志
  - 预期: 调度引擎自动恢复，任务按 cron 继续执行，日志中有新记录

- [x] 验证类型检查通过
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck`
  - 预期: 无新增类型错误（基线错误数不变）

- [x] 验证前端构建无错误
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web`
  - 预期: 构建成功，无 error

- [x] 运行所有新增单元测试
  - `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/task-schema.test.ts src/__tests__/task-service.test.ts src/__tests__/scheduler.test.ts src/__tests__/task-routes.test.ts web/src/__tests__/tasks-page.test.ts`
  - 预期: 所有测试通过