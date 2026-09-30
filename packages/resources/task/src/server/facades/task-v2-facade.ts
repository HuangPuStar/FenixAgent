/**
 * 定时任务（Task V2）的资源应用 Facade：`route → Facade → Domain Service → Repository` 的应用入口。
 *
 * 立这一层之前的形态是：`/web/tasks/v2` 的每个处理器先读 `store.authContext`，再把 `authCtx.userId` 与
 * `authCtx.organizationId` 两个字段拆开、按位置传给领域服务；执行日志的两个端点还额外在处理器里先用
 * 一次详情查询确认任务归属，再列日志。那让「以什么身份、什么范围读」这件应用层决策散落在协议层，
 * 且协议层一旦漏掉那次前置查询，日志端点就会失去归属校验。
 *
 * 现在拆成两半：
 *   - **本层**：从 actor 取出 `(organizationId, userId)` 这个归属范围并显式交给领域服务，同时承担
 *     「先确认任务归属、再做子资源操作」这条跨步骤编排（日志列表与清空）；
 *   - **领域服务**（`../services/task-v2`）：只收显式范围与领域输入，处理 cron 语义、时区、type 不可变
 *     等资源自身规则，以及调度器的挂载/卸载，不认识 actor，也不做用户权限判断。
 *
 * 授权来源：定时任务不在五张受控资源主表之列（表里没有 `visibility`），因此本包不接
 * `@fenix/access-control`、也不复制组织规则。它的租户边界是「任务归属列 `user_id` + `organization_id`
 * 同时命中调用者」——归属范围只由本层从 actor 推导，请求体与查询串都无法影响；跨用户与跨组织的任务
 * 一律表现为 `NOT_FOUND`（与不存在不可区分，避免把他人的任务 ID 变成探测面），这与迁移前逐条一致。
 *
 * 失败语义：沿用领域服务的信封（`{ success, data }` / `{ success: false, error: { code, message } }`），
 * 由路由映射为 400 / 404 / 500；本层不吞错、不改写错误码。
 */

import type { CreateTaskV2Input, UpdateTaskV2Input } from "../services/task-v2";
import {
  clearExecutionLogsV2,
  createTaskV2,
  deleteTaskV2,
  getTaskV2,
  listExecutionLogsV2,
  listTasksV2,
  toggleTaskV2,
  triggerTaskV2,
  updateTaskV2,
} from "../services/task-v2";

/**
 * 本 Facade 接受的最小主体投影。
 *
 * 只取用到的两个字段，不 import 宿主 `AuthContext`（那是 `apps/server` 协议层的类型，包一旦依赖它
 * 就无法独立构建）：`organizationId` 是组织谓词，`userId` 是任务归属谓词。宿主的 `AuthContext` 是它的
 * 结构超集，调用点无需转换；`role` / `memberships` 不进入本层判断——同组织内任务按owner隔离，
 * 与迁移前一致。
 */
export interface TaskV2Actor {
  readonly userId: string;
  readonly organizationId: string;
}

/** 列表筛选条件；组织与用户不在其中（它们由本层从 actor 推导）。 */
export interface TaskV2ListFilters {
  readonly keyword?: string;
  readonly type?: string;
  readonly agentId?: string;
}

/** 任务列表的一页。 */
export interface TaskV2ListPage {
  readonly items: Awaited<ReturnType<typeof listTasksV2>>["data"]["items"];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/** 执行日志的一页。 */
export interface TaskV2LogPage {
  readonly total: number;
  readonly items: Awaited<ReturnType<typeof listExecutionLogsV2>>["data"]["items"];
}

/**
 * 执行日志读取的结果信封。
 *
 * 日志没有自己的归属列，因此只有一种失败：所属任务对 actor 不可读（跨用户 / 跨组织 / 不存在同形）。
 */
export type TaskV2LogResult =
  | { readonly success: true; readonly data: TaskV2LogPage }
  | { readonly success: false; readonly error: { readonly code: "NOT_FOUND"; readonly message: string } };

/**
 * 定时任务的应用接口（Facade 的契约面）。
 *
 * 路由只依赖这组方法；用例可以提供实现而不触达真实数据库。方法的入参是 actor、任务 ID 与协议已校验的
 * 请求数据，归属范围由实现内部推导——调用方无法通过请求体或查询串读到、改到别人的任务。
 */
export interface TaskV2Facade {
  /** 列出当前用户在当前组织下的任务（分页）。 */
  list(actor: TaskV2Actor, page: number, pageSize: number, filters: TaskV2ListFilters): Promise<TaskV2ListPage>;
  /** 创建任务：组织与归属者取 actor，请求体里的同名值不被采信。 */
  create(actor: TaskV2Actor, input: CreateTaskV2Input): ReturnType<typeof createTaskV2>;
  /** 按 ID 读取任务；不属于 actor 时 `NOT_FOUND`（跨用户/跨组织与不存在同形）。 */
  get(actor: TaskV2Actor, taskId: string): ReturnType<typeof getTaskV2>;
  /** 更新任务；不属于 actor 时 `NOT_FOUND`，领域校验失败时 `VALIDATION_ERROR`。 */
  update(actor: TaskV2Actor, taskId: string, input: UpdateTaskV2Input): ReturnType<typeof updateTaskV2>;
  /** 删除任务；未命中返回 `NOT_FOUND`，命中后同步卸载调度。 */
  remove(actor: TaskV2Actor, taskId: string): ReturnType<typeof deleteTaskV2>;
  /** 切换启用状态；未命中返回 `NOT_FOUND`，成功后按新状态挂载/卸载调度。 */
  toggle(actor: TaskV2Actor, taskId: string): ReturnType<typeof toggleTaskV2>;
  /** 手动触发一次执行；不属于 actor 时 `NOT_FOUND`，不产生任何执行副作用。 */
  trigger(actor: TaskV2Actor, taskId: string): ReturnType<typeof triggerTaskV2>;
  /** 执行日志分页；**先确认任务属于 actor**，否则 `NOT_FOUND`（日志不是可越权读取的独立资源）。 */
  listLogs(actor: TaskV2Actor, taskId: string, page: number, pageSize: number): Promise<TaskV2LogResult>;
  /** 清空执行日志；同样先确认任务归属，未命中时不删除任何日志行。 */
  clearLogs(actor: TaskV2Actor, taskId: string): ReturnType<typeof clearExecutionLogsV2>;
}

/**
 * 进程级无状态实现：Facade 不持有连接、缓存或 actor，每次调用只用入参推导范围。
 *
 * 领域服务的方法签名保持「显式范围 + 领域输入」而不是收 actor：授权解释只在本文件发生，服务侧看到的
 * 是普通的归属字段。
 */
export const taskV2Facade: TaskV2Facade = {
  list: async (actor, page, pageSize, filters) =>
    (await listTasksV2(actor.userId, actor.organizationId, page, pageSize, filters)).data,

  create: (actor, input) => createTaskV2(actor.userId, actor.organizationId, input),

  get: (actor, taskId) => getTaskV2(actor.userId, actor.organizationId, taskId),

  update: (actor, taskId, input) => updateTaskV2(actor.userId, actor.organizationId, taskId, input),

  remove: (actor, taskId) => deleteTaskV2(actor.userId, actor.organizationId, taskId),

  toggle: (actor, taskId) => toggleTaskV2(actor.userId, actor.organizationId, taskId),

  trigger: (actor, taskId) => triggerTaskV2(actor.userId, actor.organizationId, taskId),

  listLogs: async (actor, taskId, page, pageSize) => {
    // 日志没有自己的归属列：可读性由所属任务决定，因此先做归属确认，再读日志。归属查询的唯一失败形态
    // 是不命中（跨用户 / 跨组织 / 不存在同形），故这里统一映射为 NOT_FOUND。
    const task = await getTaskV2(actor.userId, actor.organizationId, taskId);
    if (!task.success) return { success: false, error: { code: "NOT_FOUND", message: task.error.message } };
    return { success: true, data: (await listExecutionLogsV2(taskId, page, pageSize)).data };
  },

  clearLogs: (actor, taskId) => clearExecutionLogsV2(actor.userId, actor.organizationId, taskId),
};
