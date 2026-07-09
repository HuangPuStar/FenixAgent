/**
 * Workflow Definition API 路由。
 *
 * RESTful 风格（新增）：
 * - GET  /workflow-defs → 列表
 * - POST /workflow-defs → 创建 / action 分发（向后兼容）
 * - GET  /workflow-defs/recoverable → 扫描可恢复
 * - POST /workflow-defs/recover → 确认恢复
 * - GET  /workflow-defs/:id → 详情
 * - PATCH /workflow-defs/:id → 更新元数据
 * - DELETE /workflow-defs/:id → 删除
 * - PUT  /workflow-defs/:id/draft → 保存草稿
 * - POST /workflow-defs/:id/publish → 发布版本
 * - GET  /workflow-defs/:id/versions → 版本列表
 * - GET  /workflow-defs/:id/versions/:version → 版本 YAML
 * - POST /workflow-defs/:id/versions/:version/set-latest → 设为最新
 * - POST /workflow-defs/:id/versions/:version/restore → 恢复为草稿
 * - GET  /workflow-defs/:id/params → 参数定义
 * - POST /workflow-defs/:id/triggers → 创建触发器
 * - GET  /workflow-defs/:id/triggers → 触发器列表
 * - DELETE /workflow-defs/:id/triggers/:triggerId → 删除触发器
 * - POST /workflow-defs/:id/triggers/:triggerId/regenerate → 重新生成哈希
 * - POST /workflow-defs/:id/triggers/:triggerId/enable → 启用
 * - POST /workflow-defs/:id/triggers/:triggerId/disable → 禁用
 *
 * 向后兼容：POST /workflow-defs 同时接受新 REST 创建请求（无 action 字段）
 * 和旧 action 分发请求（有 action 字段）。
 */

import { createLogger } from "@fenix/logger";
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import {
  createWorkflowDef,
  deleteWorkflowDef,
  getVersions,
  getVersionYaml,
  getWorkflowDef,
  listRecoverableWorkflows,
  listWorkflowDefs,
  publishVersion,
  recoverWorkflows,
  restoreVersionToDraft,
  saveDraft,
  setLatestVersion,
  updateWorkflowMeta,
} from "../../repositories/workflow-def";
import {
  CreateTriggerRequestSchema,
  CreateWorkflowDefRequestSchema,
  GetParamDefsQuerySchema,
  RecoverWorkflowsRequestSchema,
  SaveDraftRequestSchema,
  UpdateWorkflowMetaRequestSchema,
  WorkflowDefsActionRequestSchema,
  WorkflowDefsActionResponseSchema,
  WorkflowDefsPostBodySchema,
} from "../../schemas";
import { WebErrSchema } from "../../schemas/common.schema";
import { publishWorkflowEvent } from "../../services/workflow/workflow-events";
import {
  createTrigger,
  deleteTrigger,
  disableTrigger,
  enableTrigger,
  listTriggers,
  regenerateHash,
} from "../../services/workflow-trigger";

const logger = createLogger("wf-defs");

// ── 通用辅助函数 ──

/** 提取 params.id */
function getId(params: unknown): string {
  return (params as Record<string, string> | undefined)?.id ?? "";
}
/** 提取 params.version */
function getVersion(params: unknown): number {
  return Number((params as Record<string, string> | undefined)?.version ?? "");
}
/** 提取 params.triggerId */
function getTrigger(params: unknown): string {
  return (params as Record<string, string> | undefined)?.triggerId ?? "";
}

// biome-ignore lint/suspicious/noExplicitAny: error handling helper
function handleError(err: unknown, set: any): Record<string, unknown> {
  logger.error("Error:", err);
  const cause = err instanceof Error ? err.cause : null;
  const pgMessage = cause instanceof Error ? cause.message : null;
  if (pgMessage?.includes("duplicate key") || pgMessage?.includes("unique constraint")) {
    set.status = 409;
    return { success: false, error: { code: "CONFLICT", message: pgMessage || "Duplicate key violation" } };
  }
  const message = pgMessage || (err instanceof Error ? err.message : "Unknown error");
  set.status = 500;
  return { success: false, error: { code: "INTERNAL_ERROR", message } };
}

// ── App setup ──

const app = new Elysia({ name: "web-workflow-defs" }).use(authGuardPlugin).model({
  "workflow-defs-action-request": WorkflowDefsActionRequestSchema,
  "workflow-defs-post-body": WorkflowDefsPostBodySchema,
  "workflow-defs-action-response": WorkflowDefsActionResponseSchema,
  "create-workflow-def-request": CreateWorkflowDefRequestSchema,
  "update-workflow-meta-request": UpdateWorkflowMetaRequestSchema,
  "save-draft-request": SaveDraftRequestSchema,
  "recover-workflows-request": RecoverWorkflowsRequestSchema,
  "create-trigger-request": CreateTriggerRequestSchema,
  "get-param-defs-query": GetParamDefsQuerySchema,
});

// ═══════════════════════════════════════════════════════════════════════════════
// RESTful 路由
// ═══════════════════════════════════════════════════════════════════════════════

// NOTE: 具体路径（/recoverable, /recover）必须在 /:id 之前注册

/** GET /web/workflow-defs — 获取工作流定义列表 */
app.get(
  "/workflow-defs",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store }: any) => {
    const authCtx = store.authContext!;
    const list = await listWorkflowDefs(authCtx.organizationId);
    return { success: true as const, data: list };
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Workflow Engine"],
      summary: "获取工作流定义列表",
      description: "返回当前组织下所有工作流定义。",
    },
  },
);

/** GET /web/workflow-defs/recoverable — 扫描可恢复的工作流 ID */
app.get(
  "/workflow-defs/recoverable",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store }: any) => {
    const authCtx = store.authContext!;
    const ids = await listRecoverableWorkflows(authCtx.organizationId);
    return { success: true as const, data: ids };
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Workflow Engine"],
      summary: "扫描可恢复的工作流",
      description: "扫描文件系统中存在但数据库记录被软删除的工作流，返回可恢复的 ID 列表。",
    },
  },
);

/** POST /web/workflow-defs/recover — 确认恢复工作流 */
app.post(
  "/workflow-defs/recover",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, body, set }: any) => {
    const authCtx = store.authContext!;
    const { workflowIds } = body as { workflowIds: string[] };

    if (!Array.isArray(workflowIds) || workflowIds.length === 0) {
      set.status = 400;
      return { success: false, error: { code: "VALIDATION_ERROR", message: "workflowIds array is required" } };
    }

    try {
      const recovered = await recoverWorkflows(authCtx, workflowIds);
      return { success: true as const, data: recovered };
    } catch (err: unknown) {
      return handleError(err, set);
    }
  },
  {
    sessionAuth: true,
    body: "recover-workflows-request",
    detail: {
      tags: ["Workflow Engine"],
      summary: "恢复工作流",
      description: "从文件系统恢复已删除的工作流定义。",
    },
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// 子资源路由（必须在 /:id 通用路由之前注册，防止 Elysia 路由误匹配）
// ═══════════════════════════════════════════════════════════════════════════════

/** PUT /web/workflow-defs/:id/draft — 保存工作流草稿 */
app.put(
  "/workflow-defs/:id/draft",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, body, set }: any) => {
    const authCtx = store.authContext!;
    const workflowId = getId(params);
    const { yaml } = body as { yaml: string };

    if (!workflowId || !yaml) {
      set.status = 400;
      return { success: false, error: { code: "VALIDATION_ERROR", message: "workflowId and yaml are required" } };
    }

    try {
      await saveDraft(workflowId, authCtx, yaml);
      publishWorkflowEvent(workflowId, "workflow.draft_updated", { yaml });
      return { success: true as const, data: null };
    } catch (err: unknown) {
      return handleError(err, set);
    }
  },
  {
    sessionAuth: true,
    body: "save-draft-request",
    detail: {
      tags: ["Workflow Engine"],
      summary: "保存工作流草稿",
      description: "将工作流 YAML 保存为当前草稿，不生成版本号。",
    },
  },
);

/** POST /web/workflow-defs/:id/publish — 发布版本 */
app.post(
  "/workflow-defs/:id/publish",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, set }: any) => {
    const authCtx = store.authContext!;
    const workflowId = getId(params);

    if (!workflowId) {
      set.status = 400;
      return { success: false, error: { code: "VALIDATION_ERROR", message: "workflowId is required" } };
    }

    try {
      const vRow = await publishVersion(workflowId, authCtx);
      publishWorkflowEvent(workflowId, "workflow.version_published", { version: vRow?.version });
      return { success: true as const, data: vRow };
    } catch (err: unknown) {
      return handleError(err, set);
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Workflow Engine"],
      summary: "发布工作流版本",
      description: "将当前草稿发布为一个新的带版本号的工作流版本。",
    },
  },
);

// ── 版本相关 ──

/** GET /web/workflow-defs/:id/versions — 获取版本历史 */
app.get(
  "/workflow-defs/:id/versions",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, set }: any) => {
    const authCtx = store.authContext!;
    const workflowId = getId(params);

    if (!workflowId) {
      set.status = 400;
      return { success: false, error: { code: "VALIDATION_ERROR", message: "workflowId is required" } };
    }

    const versions = await getVersions(workflowId, authCtx.organizationId);
    return { success: true as const, data: versions };
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Workflow Engine"],
      summary: "获取版本历史",
      description: "返回指定工作流的所有历史版本记录。",
    },
  },
);

/** GET /web/workflow-defs/:id/versions/:version — 获取指定版本 YAML */
app.get(
  "/workflow-defs/:id/versions/:version",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, set }: any) => {
    const authCtx = store.authContext!;
    const workflowId = getId(params);
    const version = getVersion(params);

    if (!workflowId || Number.isNaN(version)) {
      set.status = 400;
      return { success: false, error: { code: "VALIDATION_ERROR", message: "workflowId and version are required" } };
    }

    const wf = await getWorkflowDef(workflowId, authCtx.organizationId);
    if (!wf) {
      set.status = 404;
      return { success: false, error: { code: "NOT_FOUND", message: "Workflow not found" } };
    }

    const yaml = await getVersionYaml(workflowId, version, {
      organizationId: authCtx.organizationId,
      storagePath: wf.storagePath,
    });

    if (!yaml) {
      set.status = 404;
      return { success: false, error: { code: "NOT_FOUND", message: "Version not found" } };
    }

    return { success: true as const, data: { workflowId, version, yaml } };
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Workflow Engine"],
      summary: "获取版本 YAML",
      description: "返回指定工作流某个版本的完整 YAML 内容。",
    },
  },
);

/** POST /web/workflow-defs/:id/versions/:version/set-latest — 设为最新版本 */
app.post(
  "/workflow-defs/:id/versions/:version/set-latest",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, set }: any) => {
    const authCtx = store.authContext!;
    const workflowId = getId(params);
    const version = getVersion(params);

    if (!workflowId || Number.isNaN(version)) {
      set.status = 400;
      return { success: false, error: { code: "VALIDATION_ERROR", message: "workflowId and version are required" } };
    }

    try {
      await setLatestVersion(workflowId, authCtx.organizationId, version);
      return { success: true as const, data: null };
    } catch (err: unknown) {
      return handleError(err, set);
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Workflow Engine"],
      summary: "设为最新版本",
      description: "将指定版本标记为工作流的当前最新版本（回滚操作）。",
    },
  },
);

/** POST /web/workflow-defs/:id/versions/:version/restore — 恢复版本到草稿 */
app.post(
  "/workflow-defs/:id/versions/:version/restore",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, set }: any) => {
    const authCtx = store.authContext!;
    const workflowId = getId(params);
    const version = getVersion(params);

    if (!workflowId || Number.isNaN(version)) {
      set.status = 400;
      return { success: false, error: { code: "VALIDATION_ERROR", message: "workflowId and version are required" } };
    }

    try {
      await restoreVersionToDraft(workflowId, authCtx, version);
      publishWorkflowEvent(workflowId, "workflow.draft_restored", { version });
      return { success: true as const, data: null };
    } catch (err: unknown) {
      return handleError(err, set);
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Workflow Engine"],
      summary: "恢复版本至草稿",
      description: "将指定历史版本的内容恢复为当前工作流的草稿。",
    },
  },
);

// ── 参数定义 ──

/** GET /web/workflow-defs/:id/params — 获取工作流参数定义 */
app.get(
  "/workflow-defs/:id/params",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, query, set }: any) => {
    const authCtx = store.authContext!;
    const workflowId = getId(params);

    if (!workflowId) {
      set.status = 400;
      return { success: false, error: { code: "VALIDATION_ERROR", message: "workflowId is required" } };
    }

    const wf = await getWorkflowDef(workflowId, authCtx.organizationId);
    if (!wf) {
      set.status = 404;
      return { success: false, error: { code: "NOT_FOUND", message: "Workflow not found" } };
    }

    const storagePath = wf.storagePath;
    // biome-ignore lint/suspicious/noExplicitAny: query param access
    const q = query as any;
    const targetVersion = q?.version != null ? Number(q.version) : (wf.latestVersion ?? 0);

    const yaml = await getVersionYaml(workflowId, targetVersion, {
      organizationId: authCtx.organizationId,
      storagePath,
    });

    if (!yaml) {
      set.status = 404;
      return { success: false, error: { code: "NOT_FOUND", message: "Version not found" } };
    }

    let paramsObj: Record<string, unknown> = {};
    try {
      const { parseWorkflowYaml } = await import("@fenix/workflow-engine");
      const def = parseWorkflowYaml(yaml);
      paramsObj = (def.params as Record<string, unknown>) ?? {};
    } catch {
      // YAML 解析失败，返回空 params
    }

    return { success: true as const, data: { version: targetVersion, params: paramsObj } };
  },
  {
    sessionAuth: true,
    query: "get-param-defs-query",
    detail: {
      tags: ["Workflow Engine"],
      summary: "获取参数定义",
      description: "从工作流 YAML 中提取参数定义。可通过 query version= 指定版本，未传时使用最新版本。",
    },
  },
);

// ── 触发器 ──

/** POST /web/workflow-defs/:id/triggers — 创建触发器 */
app.post(
  "/workflow-defs/:id/triggers",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, body, set }: any) => {
    const authCtx = store.authContext!;
    const workflowId = getId(params);

    if (!workflowId) {
      set.status = 400;
      return { success: false, error: { code: "VALIDATION_ERROR", message: "workflowId is required" } };
    }

    const { type = "webhook", config } = body as { type?: string; config?: Record<string, unknown> };

    const wf = await getWorkflowDef(workflowId, authCtx.organizationId);
    if (!wf) {
      set.status = 404;
      return { success: false, error: { code: "NOT_FOUND", message: "Workflow not found" } };
    }

    try {
      const trigger = await createTrigger({
        organizationId: authCtx.organizationId,
        workflowId,
        type,
        userId: authCtx.userId,
        config,
      });
      return { success: true as const, data: trigger };
    } catch (err: unknown) {
      return handleError(err, set);
    }
  },
  {
    sessionAuth: true,
    body: "create-trigger-request",
    detail: {
      tags: ["Workflow Engine"],
      summary: "创建触发器",
      description: "为指定工作流创建一个新的 webhook 触发器。",
    },
  },
);

/** GET /web/workflow-defs/:id/triggers — 列出触发器 */
app.get(
  "/workflow-defs/:id/triggers",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, set }: any) => {
    const authCtx = store.authContext!;
    const workflowId = getId(params);

    if (!workflowId) {
      set.status = 400;
      return { success: false, error: { code: "VALIDATION_ERROR", message: "workflowId is required" } };
    }

    const wf = await getWorkflowDef(workflowId, authCtx.organizationId);
    if (!wf) {
      set.status = 404;
      return { success: false, error: { code: "NOT_FOUND", message: "Workflow not found" } };
    }

    const triggers = await listTriggers(workflowId, authCtx.organizationId);
    return { success: true as const, data: triggers };
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Workflow Engine"],
      summary: "列出触发器",
      description: "返回指定工作流下的所有触发器。",
    },
  },
);

/** DELETE /web/workflow-defs/:id/triggers/:triggerId — 删除触发器 */
app.delete(
  "/workflow-defs/:id/triggers/:triggerId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, set }: any) => {
    const authCtx = store.authContext!;
    const triggerId = getTrigger(params);

    if (!triggerId) {
      set.status = 400;
      return { success: false, error: { code: "VALIDATION_ERROR", message: "triggerId is required" } };
    }

    try {
      const deleted = await deleteTrigger(triggerId, authCtx.organizationId);
      if (!deleted) {
        set.status = 404;
        return { success: false, error: { code: "NOT_FOUND", message: "Trigger not found" } };
      }
      return { success: true as const, data: null };
    } catch (err: unknown) {
      return handleError(err, set);
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Workflow Engine"],
      summary: "删除触发器",
      description: "删除指定的触发器。",
    },
  },
);

/** POST /web/workflow-defs/:id/triggers/:triggerId/regenerate — 重新生成哈希 */
app.post(
  "/workflow-defs/:id/triggers/:triggerId/regenerate",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, set }: any) => {
    const authCtx = store.authContext!;
    const triggerId = getTrigger(params);

    if (!triggerId) {
      set.status = 400;
      return { success: false, error: { code: "VALIDATION_ERROR", message: "triggerId is required" } };
    }

    try {
      const result = await regenerateHash(triggerId, authCtx.organizationId);
      if (!result) {
        set.status = 404;
        return { success: false, error: { code: "NOT_FOUND", message: "Trigger not found" } };
      }
      return { success: true as const, data: result };
    } catch (err: unknown) {
      return handleError(err, set);
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Workflow Engine"],
      summary: "重新生成触发器哈希",
      description: "为指定触发器重新生成公开哈希标识。",
    },
  },
);

/** POST /web/workflow-defs/:id/triggers/:triggerId/enable — 启用触发器 */
app.post(
  "/workflow-defs/:id/triggers/:triggerId/enable",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, set }: any) => {
    const authCtx = store.authContext!;
    const triggerId = getTrigger(params);

    if (!triggerId) {
      set.status = 400;
      return { success: false, error: { code: "VALIDATION_ERROR", message: "triggerId is required" } };
    }

    try {
      const ok = await enableTrigger(triggerId, authCtx.organizationId);
      if (!ok) {
        set.status = 404;
        return { success: false, error: { code: "NOT_FOUND", message: "Trigger not found" } };
      }
      return { success: true as const, data: null };
    } catch (err: unknown) {
      return handleError(err, set);
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Workflow Engine"],
      summary: "启用触发器",
      description: "启用指定的触发器。",
    },
  },
);

/** POST /web/workflow-defs/:id/triggers/:triggerId/disable — 禁用触发器 */
app.post(
  "/workflow-defs/:id/triggers/:triggerId/disable",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, set }: any) => {
    const authCtx = store.authContext!;
    const triggerId = getTrigger(params);

    if (!triggerId) {
      set.status = 400;
      return { success: false, error: { code: "VALIDATION_ERROR", message: "triggerId is required" } };
    }

    try {
      const ok = await disableTrigger(triggerId, authCtx.organizationId);
      if (!ok) {
        set.status = 404;
        return { success: false, error: { code: "NOT_FOUND", message: "Trigger not found" } };
      }
      return { success: true as const, data: null };
    } catch (err: unknown) {
      return handleError(err, set);
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Workflow Engine"],
      summary: "禁用触发器",
      description: "禁用指定的触发器。",
    },
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// 通用 /:id 路由（必须在所有子资源路由之后注册）
// ═══════════════════════════════════════════════════════════════════════════════

/** GET /web/workflow-defs/:id — 获取工作流详情（含草稿 YAML） */
app.get(
  "/workflow-defs/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, set }: any) => {
    const authCtx = store.authContext!;
    const workflowId = getId(params);

    if (!workflowId) {
      set.status = 400;
      return { success: false, error: { code: "VALIDATION_ERROR", message: "workflowId is required" } };
    }

    const wf = await getWorkflowDef(workflowId, authCtx.organizationId);
    if (!wf) {
      set.status = 404;
      return { success: false, error: { code: "NOT_FOUND", message: "Workflow not found" } };
    }

    const draftYaml = await getVersionYaml(workflowId, 0, {
      organizationId: authCtx.organizationId,
      storagePath: wf.storagePath,
    });

    return { success: true as const, data: { ...wf, draftYaml } };
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Workflow Engine"],
      summary: "获取工作流详情",
      description: "返回工作流定义信息及当前草稿 YAML 内容。",
    },
  },
);

/** PATCH /web/workflow-defs/:id — 更新工作流元数据 */
app.patch(
  "/workflow-defs/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, body, set }: any) => {
    const authCtx = store.authContext!;
    const workflowId = getId(params);

    if (!workflowId) {
      set.status = 400;
      return { success: false, error: { code: "VALIDATION_ERROR", message: "workflowId is required" } };
    }

    const { name, description } = body as { name?: string; description?: string };

    try {
      const updated = await updateWorkflowMeta(workflowId, authCtx.organizationId, { name, description });
      if (!updated) {
        set.status = 404;
        return { success: false, error: { code: "NOT_FOUND", message: "Workflow not found" } };
      }
      publishWorkflowEvent(workflowId, "workflow.meta_updated", { name, description });
      return { success: true as const, data: updated };
    } catch (err: unknown) {
      return handleError(err, set);
    }
  },
  {
    sessionAuth: true,
    body: "update-workflow-meta-request",
    detail: {
      tags: ["Workflow Engine"],
      summary: "更新工作流元数据",
      description: "更新工作流的名称和/或描述信息。使用 PATCH 进行部分更新。",
    },
  },
);

/** DELETE /web/workflow-defs/:id — 删除工作流定义 */
app.delete(
  "/workflow-defs/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, params, set }: any) => {
    const authCtx = store.authContext!;
    const workflowId = getId(params);

    if (!workflowId) {
      set.status = 400;
      return { success: false, error: { code: "VALIDATION_ERROR", message: "workflowId is required" } };
    }

    try {
      const deleted = await deleteWorkflowDef(workflowId, authCtx.organizationId);
      if (!deleted) {
        set.status = 404;
        return { success: false, error: { code: "NOT_FOUND", message: "Workflow not found" } };
      }
      publishWorkflowEvent(workflowId, "workflow.deleted", {});
      return { success: true as const, data: null };
    } catch (err: unknown) {
      return handleError(err, set);
    }
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["Workflow Engine"],
      summary: "删除工作流定义",
      description: "软删除指定工作流定义，可随后通过扫描恢复。",
    },
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
// 向后兼容：POST /workflow-defs action 分发路由
// ═══════════════════════════════════════════════════════════════════════════════

app.post(
  "/workflow-defs",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;

    const payload = body as Record<string, unknown>;

    // 新 REST 风格：body 中无 action 字段 → 按创建工作流处理
    if (!payload.action) {
      const name = payload.name as string;
      const description = payload.description as string | undefined;
      if (!name?.trim()) {
        return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "name is required" } });
      }
      try {
        const row = await createWorkflowDef(authCtx, { name: name.trim(), description });
        publishWorkflowEvent(row.id, "workflow.created", {});
        return { success: true, data: row };
      } catch (err: unknown) {
        const cause = err instanceof Error ? err.cause : null;
        const pgMessage = cause instanceof Error ? cause.message : null;
        if (pgMessage?.includes("duplicate key") || pgMessage?.includes("unique constraint")) {
          return error(409, {
            success: false,
            error: { code: "CONFLICT", message: "同一组织下工作流名称已存在" },
          });
        }
        return error(500, {
          success: false,
          error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Unknown error" },
        });
      }
    }

    const action = payload.action as string;

    try {
      switch (action) {
        case "create": {
          const name = payload.name as string;
          const description = payload.description as string | undefined;
          if (!name?.trim()) {
            return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "name is required" } });
          }
          const row = await createWorkflowDef(authCtx, { name: name.trim(), description });
          publishWorkflowEvent(row.id, "workflow.created", {});
          return { success: true, data: row };
        }

        case "save": {
          const workflowId = payload.workflowId as string;
          const yaml = payload.yaml as string;
          if (!workflowId || !yaml) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "workflowId and yaml are required" },
            });
          }
          await saveDraft(workflowId, authCtx, yaml);
          publishWorkflowEvent(workflowId, "workflow.draft_updated", { yaml });
          return { success: true, data: null };
        }

        case "publish": {
          const workflowId = payload.workflowId as string;
          if (!workflowId) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "workflowId is required" },
            });
          }
          const vRow = await publishVersion(workflowId, authCtx);
          publishWorkflowEvent(workflowId, "workflow.version_published", {
            version: vRow?.version,
          });
          return { success: true, data: vRow };
        }

        case "list": {
          const list = await listWorkflowDefs(authCtx.organizationId);
          return { success: true, data: list };
        }

        case "get": {
          const workflowId = payload.workflowId as string;
          if (!workflowId)
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "workflowId is required" },
            });
          const wf = await getWorkflowDef(workflowId, authCtx.organizationId);
          if (!wf) return error(404, { success: false, error: { code: "NOT_FOUND", message: "Workflow not found" } });
          const draftYaml = await getVersionYaml(workflowId, 0, {
            organizationId: authCtx.organizationId,
            storagePath: wf.storagePath,
          });
          return { success: true, data: { ...wf, draftYaml } };
        }

        case "getVersions": {
          const workflowId = payload.workflowId as string;
          if (!workflowId)
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "workflowId is required" },
            });
          const versions = await getVersions(workflowId, authCtx.organizationId);
          return { success: true, data: versions };
        }

        case "getVersion": {
          const workflowId = payload.workflowId as string;
          const version = payload.version as number;
          if (!workflowId || version === undefined) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "workflowId and version are required" },
            });
          }
          const wf = await getWorkflowDef(workflowId, authCtx.organizationId);
          if (!wf) return error(404, { success: false, error: { code: "NOT_FOUND", message: "Workflow not found" } });
          const yaml = await getVersionYaml(workflowId, version, {
            organizationId: authCtx.organizationId,
            storagePath: wf.storagePath,
          });
          if (!yaml) return error(404, { success: false, error: { code: "NOT_FOUND", message: "Version not found" } });
          return { success: true, data: { workflowId, version, yaml } };
        }

        case "setLatest": {
          const workflowId = payload.workflowId as string;
          const version = payload.version as number;
          if (!workflowId || version === undefined) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "workflowId and version are required" },
            });
          }
          await setLatestVersion(workflowId, authCtx.organizationId, version);
          return { success: true, data: null };
        }

        case "delete": {
          const workflowId = payload.workflowId as string;
          if (!workflowId)
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "workflowId is required" },
            });
          const deleted = await deleteWorkflowDef(workflowId, authCtx.organizationId);
          if (!deleted)
            return error(404, { success: false, error: { code: "NOT_FOUND", message: "Workflow not found" } });
          publishWorkflowEvent(workflowId, "workflow.deleted", {});
          return { success: true, data: null };
        }

        case "updateMeta": {
          const workflowId = payload.workflowId as string;
          const name = payload.name as string | undefined;
          const description = payload.description as string | undefined;
          if (!workflowId)
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "workflowId is required" },
            });
          const updated = await updateWorkflowMeta(workflowId, authCtx.organizationId, { name, description });
          if (!updated)
            return error(404, { success: false, error: { code: "NOT_FOUND", message: "Workflow not found" } });
          publishWorkflowEvent(workflowId, "workflow.meta_updated", { name, description });
          return { success: true, data: updated };
        }

        case "recover": {
          const ids = await listRecoverableWorkflows(authCtx.organizationId);
          return { success: true, data: ids };
        }

        case "recoverApply": {
          const workflowIds = payload.workflowIds as string[];
          if (!Array.isArray(workflowIds) || workflowIds.length === 0) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "workflowIds array is required" },
            });
          }
          const recovered = await recoverWorkflows(authCtx, workflowIds);
          return { success: true, data: recovered };
        }

        case "restoreToDraft": {
          const workflowId = payload.workflowId as string;
          const version = payload.version as number;
          if (!workflowId || version === undefined) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "workflowId and version are required" },
            });
          }
          await restoreVersionToDraft(workflowId, authCtx, version);
          publishWorkflowEvent(workflowId, "workflow.draft_restored", { version });
          return { success: true, data: null };
        }

        // ── Workflow Trigger ──

        case "createTrigger": {
          const workflowId = payload.workflowId as string;
          const triggerType = (payload.type as string) || "webhook";
          const triggerConfig = payload.config as Record<string, unknown> | undefined;
          if (!workflowId) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "workflowId is required" },
            });
          }
          const wf = await getWorkflowDef(workflowId, authCtx.organizationId);
          if (!wf) return error(404, { success: false, error: { code: "NOT_FOUND", message: "Workflow not found" } });
          const trigger = await createTrigger({
            organizationId: authCtx.organizationId,
            workflowId,
            type: triggerType,
            userId: authCtx.userId,
            config: triggerConfig,
          });
          return { success: true, data: trigger };
        }

        case "listTriggers": {
          const workflowId = payload.workflowId as string;
          if (!workflowId) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "workflowId is required" },
            });
          }
          const wf = await getWorkflowDef(workflowId, authCtx.organizationId);
          if (!wf) return error(404, { success: false, error: { code: "NOT_FOUND", message: "Workflow not found" } });
          const triggers = await listTriggers(workflowId, authCtx.organizationId);
          return { success: true, data: triggers };
        }

        case "deleteTrigger": {
          const triggerId = payload.triggerId as string;
          if (!triggerId) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "triggerId is required" },
            });
          }
          const deleted = await deleteTrigger(triggerId, authCtx.organizationId);
          if (!deleted)
            return error(404, { success: false, error: { code: "NOT_FOUND", message: "Trigger not found" } });
          return { success: true, data: null };
        }

        case "regenerateHash": {
          const triggerId = payload.triggerId as string;
          if (!triggerId) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "triggerId is required" },
            });
          }
          const result = await regenerateHash(triggerId, authCtx.organizationId);
          if (!result)
            return error(404, { success: false, error: { code: "NOT_FOUND", message: "Trigger not found" } });
          return { success: true, data: result };
        }

        case "enableTrigger": {
          const triggerId = payload.triggerId as string;
          if (!triggerId) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "triggerId is required" },
            });
          }
          const ok = await enableTrigger(triggerId, authCtx.organizationId);
          if (!ok) return error(404, { success: false, error: { code: "NOT_FOUND", message: "Trigger not found" } });
          return { success: true, data: null };
        }

        case "disableTrigger": {
          const triggerId = payload.triggerId as string;
          if (!triggerId) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "triggerId is required" },
            });
          }
          const ok = await disableTrigger(triggerId, authCtx.organizationId);
          if (!ok) return error(404, { success: false, error: { code: "NOT_FOUND", message: "Trigger not found" } });
          return { success: true, data: null };
        }

        case "getParamDefs": {
          const workflowId = payload.workflowId as string;
          const version = payload.version as number | undefined;
          if (!workflowId) {
            return error(400, {
              success: false,
              error: { code: "VALIDATION_ERROR", message: "workflowId is required" },
            });
          }

          let targetVersion = version;
          const wf = await getWorkflowDef(workflowId, authCtx.organizationId);
          if (!wf) return error(404, { success: false, error: { code: "NOT_FOUND", message: "Workflow not found" } });
          const storagePath = wf.storagePath;
          if (targetVersion === undefined) {
            targetVersion = wf.latestVersion ?? 0;
          }

          const yaml = await getVersionYaml(workflowId, targetVersion, {
            organizationId: authCtx.organizationId,
            storagePath,
          });
          if (!yaml) return error(404, { success: false, error: { code: "NOT_FOUND", message: "Version not found" } });

          let paramsObj: Record<string, unknown> = {};
          try {
            const { parseWorkflowYaml } = await import("@fenix/workflow-engine");
            const def = parseWorkflowYaml(yaml);
            paramsObj = (def.params as Record<string, unknown>) ?? {};
          } catch {
            // YAML 解析失败，返回空 params
          }

          return { success: true, data: { version: targetVersion, params: paramsObj } };
        }

        default:
          return error(400, {
            success: false,
            error: { code: "VALIDATION_ERROR", message: `Unknown action: ${action}` },
          });
      }
    } catch (err: unknown) {
      logger.error("Error:", err);
      const cause = err instanceof Error ? err.cause : null;
      const pgMessage = cause instanceof Error ? cause.message : null;
      if (pgMessage?.includes("duplicate key") || pgMessage?.includes("unique constraint")) {
        return error(409, {
          success: false,
          error: { code: "CONFLICT", message: "同一组织下工作流名称已存在" },
        });
      }
      const message = pgMessage || (err instanceof Error ? err.message : "Unknown error");
      return error(500, { success: false, error: { code: "INTERNAL_ERROR", message } });
    }
  },
  {
    sessionAuth: true,
    body: "workflow-defs-post-body",
    response: {
      200: "workflow-defs-action-response",
      400: WebErrSchema,
      404: WebErrSchema,
      409: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      tags: ["Workflow Engine"],
      summary: "工作流定义管理（action 分发，向后兼容）",
      description:
        "通过 action 分发管理工作流定义、版本、草稿恢复、触发器和参数提取。同时支持新 REST 风格：无 action 字段时按创建工作流处理。",
    },
  },
);

export default app;
