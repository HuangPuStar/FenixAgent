import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Workflow V2 领域表的 schema 唯一真相来源。
 *
 * 四张表（interface-freeze §3）承载「FenixAgent ↔ 上游工作流引擎」的身份映射与本地元数据：
 * - `workflow_v2_platform_account`：平台在上游的唯一账号（单行，**不存 session_key**——会话只在
 *   workflow-v2 进程内存里，见设计 §4.6）；
 * - `workflow_v2_org_app`：租户 ↔ 上游应用（bot）的一对一绑定（两个唯一索引从存储层保证一对一）；
 * - `workflow_v2_workflow`：本地注册表。上游侧只校验 space 成员关系、**不校验 workflow ↔ App 归属**，
 *   因此「这条 workflow 属于哪个租户」只能由本表的 `organization_id` 承担（设计 §1.4）；
 * - `workflow_v2_audit_log`：控制面与透传面的审计流水，只追加不修改。
 *
 * 刻意不加外键：`organization_id` / `owner_user_id` 与其它资源包（`mcp_server`、`plugin_market_package`
 * 等）一致地保持无 FK 的 text 列——组织与用户删除的级联由身份模块负责，资源包不重复声明。四张表之间
 * 也不建外键：`workflow_v2_workflow` 归属 `organization_id`，与 `workflow_v2_org_app` 的 App 绑定是
 * 租户级别的**运行期**映射（App 可重绑，历史行不得因重绑失去可读性），外键会把这条业务上可变更的关系
 * 固化成删除语义。
 *
 * 迁移流程：`drizzle.config.ts` 的 schema 数组已登记本文件出口 → `bun run db:generate --name
 * workflow-v2-<change>` → 审查 SQL → `bun run db:migrate`。
 */

/**
 * 平台在上游的唯一账号（FenixAgent 整体 ↔ 上游 1 个用户）。
 *
 * 单行表：`platform_user_id` 的唯一索引同时是「进程内不会出现第二个平台账号」的存储层保证。`session_key`
 * 不落库（内存持有，设计 §4.6）；`status` 取 `active` / `degraded`，`last_error` 只记最后一条降级原因，
 * 两者共同表达「凭据还能不能用」这一运行期事实。
 */
export const workflowV2PlatformAccount = pgTable(
  "workflow_v2_platform_account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 上游用户 ID；唯一索引即「单行表」的存储层表达。 */
    platformUserId: text("platform_user_id").notNull(),
    /** 平台个人空间 ID；建租户 App 与创建 workflow 时的 `space_id` 注入源。 */
    platformSpaceId: text("platform_space_id").notNull(),
    /** 登录邮箱（非密钥材料，但仍不得进面向用户的响应：控制台面只暴露 user/space id 与状态）。 */
    email: text("email").notNull(),
    /** `active` | `degraded`：degraded 表示最近一次登录或探活失败，写接口应快速失败。 */
    status: text("status").notNull().default("active"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    lastProbeAt: timestamp("last_probe_at", { withTimezone: true }),
    /** 最后一次降级原因；不得写入凭据或上游响应原文中的敏感字段。 */
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("idx_workflow_v2_platform_account_platform_user").on(table.platformUserId)],
);

/**
 * 租户（organization）↔ 上游应用（bot）的一对一绑定。
 *
 * 两个唯一索引缺一不可：`organization_id` 唯一保证一个租户不会被绑到两个 App，`app_id` 唯一保证
 * 一个 App 不会被两个租户共享（共享即跨租户可见性）。`status` 留作绑定失效（App 被删、权限回收）的
 * 显式表达，重绑走 `POST /web/workflow-v2/org-app/rebind`。
 */
export const workflowV2OrgApp = pgTable(
  "workflow_v2_org_app",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    appId: text("app_id").notNull(),
    name: text("name").notNull(),
    /** `active` | `degraded`：与平台账号同口径，degraded 时该租户的写操作快速失败。 */
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_workflow_v2_org_app_organization").on(table.organizationId),
    uniqueIndex("idx_workflow_v2_org_app_app").on(table.appId),
  ],
);

/**
 * 本地 workflow 注册表（归属校验的唯一依据）。
 *
 * `upstream_workflow_id` 唯一：它是跨系统身份，本地主键 `id` 只服务我方路由。`deleted_at` 与
 * `sync_state` 一起表达软删（`active` → `pending_delete` → 行保留）：上游侧删除失败时先标
 * `pending_delete`，由对账任务重试，绝不把「上游可能还存在」的 workflow 从本地抹掉。
 *
 * 索引 `(organization_id, deleted_at)` 服务列表查询的固定谓词「本租户 + 未删除」。
 */
export const workflowV2Workflow = pgTable(
  "workflow_v2_workflow",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    upstreamWorkflowId: text("upstream_workflow_id").notNull(),
    /** 租户 App ID（上游的 `project_id`）；同一 workflow 始终属于创建时的 App。 */
    appId: text("app_id").notNull(),
    name: text("name").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    /** 平台受众列，默认 `private`；授权谓词由 `@fenix/access-control` 产出。 */
    visibility: text("visibility").notNull().default("private"),
    /** 上游侧最新发布版本号；未发布为 null。 */
    publishedVersion: text("published_version"),
    /** `active` | `pending_delete`：软删状态，对账任务据此重试上游删除。 */
    syncState: text("sync_state").notNull().default("active"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_workflow_v2_workflow_upstream").on(table.upstreamWorkflowId),
    index("idx_workflow_v2_workflow_org_deleted").on(table.organizationId, table.deletedAt),
  ],
);

/**
 * 审计流水（只追加）。
 *
 * `upstream_workflow_id` 与 `request_id` 可空：绑定 App、平台账号重登一类动作不属于任何 workflow，也不
 * 一定来自一次带 requestId 的 HTTP 请求。`result` 记归一化结果（如 `ok` / `upstream_permission_denied`），
 * `error_code` 记我方错误码。**不记 body 与凭据**（设计 §5.3 的审计口径）。
 *
 * 第二个索引 `(action, upstream_workflow_id)` 服务对账任务：创建补偿（`workflow.create.compensation` /
 * `pending_cleanup`）的收敛判据按「动作 + 上游 workflow 身份」查，没有它每轮对账都要全表扫这张只追加的表
 * （4A，2026-09-29）。
 */
export const workflowV2AuditLog = pgTable(
  "workflow_v2_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    /** 动作名（如 `workflow.create` / `canvas.passthrough` / `org_app.bind`）。 */
    action: text("action").notNull(),
    upstreamWorkflowId: text("upstream_workflow_id"),
    /** 宿主中间件写入的请求标识；无请求上下文的动作（对账、重登）为空。 */
    requestId: text("request_id"),
    result: text("result").notNull(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_workflow_v2_audit_log_org_created").on(table.organizationId, table.createdAt),
    index("idx_workflow_v2_audit_log_action_workflow").on(table.action, table.upstreamWorkflowId),
  ],
);
