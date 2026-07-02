/**
 * Workflow 运行记录 REST 路由。
 *
 * 提供工作流执行的创建、状态查询、事件读取、审批、取消、恢复、重跑等能力。
 * 原有 POST /web/workflow-engine 的 action 分发方式保留在 workflow-engine.ts 中作为向后兼容。
 */

import { createLogger } from "@fenix/logger";
import { WorkflowError } from "@fenix/workflow-engine";
import { and, eq } from "drizzle-orm";
import Elysia from "elysia";
import { db } from "../../db";
import { workflowSnapshot } from "../../db/schema";
import { authGuardPlugin } from "../../plugins/auth";
import { getVersionYaml, getWorkflowDef } from "../../repositories/workflow-def";
import {
  WorkflowApproveRequestBodySchema,
  WorkflowCancelRequestBodySchema,
  WorkflowDryRunRequestBodySchema,
  WorkflowEventsQuerySchema,
  WorkflowRecoverRequestBodySchema,
  WorkflowRerunRequestBodySchema,
  WorkflowRunIdParamsSchema,
  WorkflowRunNodeParamsSchema,
  WorkflowRunRequestBodySchema,
  WorkflowRunsQuerySchema,
  WorkflowRunsResponseSchema,
  WorkflowRunsRouteQuerySchema,
} from "../../schemas";
import { WebErrSchema, WebOkSchema } from "../../schemas/common.schema";
import {
  WorkflowDagEventSchema,
  WorkflowDagRunResultSchema,
  WorkflowDagSnapshotSchema,
  WorkflowDryRunResultSchema,
  WorkflowNodeOutputSchema,
  WorkflowPendingApprovalSchema,
  WorkflowRunStartedSchema,
  WorkflowVoidSuccessSchema,
} from "../../schemas/workflow.schema";
import { cleanupSpawnedEnvironments, getTeamEngine } from "../../services/workflow";
import { createPgStorageAdapter } from "../../services/workflow/pg-storage-adapter";
import { resolveYaml } from "../../services/workflow/resolve-yaml";
import { publishWorkflowEvent } from "../../services/workflow/workflow-events";

const logger = createLogger("wf-runs");

/** 构造 workflow engine 的公共依赖（YAML 解析）。 */
function resolveDeps(organizationId: string) {
  return { getWorkflowDef, getVersionYaml };
}

const app = new Elysia({ name: "web-workflow-runs" }).use(authGuardPlugin);

// ── GET /web/workflow-runs — 分页查询运行记录 ──

app.get(
  "/workflow-runs",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, query, error }: any) => {
    const authCtx = store.authContext!;
    const parsed = WorkflowRunsQuerySchema.safeParse(query);
    if (!parsed.success) {
      return error(400, { success: false, error: { code: "INVALID_PARAMS", message: parsed.error.message } });
    }
    const { page, pageSize, status, q } = parsed.data;

    try {
      const storage = createPgStorageAdapter(authCtx.organizationId);
      const result = await storage.listRuns({ page, pageSize, status, q });
      return { success: true, data: { ...result, page, pageSize } };
    } catch (err) {
      // 数据库连接或其他运行时异常：不泄露内部堆栈给客户端
      logger.error("listRuns failed:", err);
      return error(500, {
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Failed to list workflow runs" },
      });
    }
  },
  {
    sessionAuth: true,
    query: WorkflowRunsRouteQuerySchema,
    response: {
      200: WorkflowRunsResponseSchema,
      400: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      summary: "获取运行记录列表",
      description: "分页查询工作流运行记录，支持按状态过滤和按工作流名称模糊搜索。",
      tags: ["Workflow Engine"],
    },
  },
);

// ── POST /web/workflow-runs — 执行工作流（异步启动，立即返回 runId） ──

app.post(
  "/workflow-runs",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const engine = getTeamEngine(authCtx.organizationId);
    const deps = resolveDeps(authCtx.organizationId);
    const payload = body as typeof WorkflowRunRequestBodySchema._output;

    try {
      const yaml = await resolveYaml(payload, authCtx.organizationId, deps);
      if (!yaml) {
        return error(400, {
          success: false,
          error: { code: "VALIDATION_ERROR", message: "yaml or workflowId is required" },
        });
      }
      const params = payload.params as Record<string, unknown> | undefined;
      const workflowId = payload.workflowId;
      const { runId, result } = engine.runAsync(yaml, params);
      // 发布 run_started SSE 事件（runId 已知）
      if (workflowId) {
        publishWorkflowEvent(workflowId, "workflow.run_started", { runId });
      }
      // 后台收尾：回写 workflowId + 发布终止 SSE 事件 + 清理环境实例
      result.then(
        async (r) => {
          try {
            if (workflowId) {
              await db
                .update(workflowSnapshot)
                .set({ workflowId })
                .where(
                  and(eq(workflowSnapshot.runId, runId), eq(workflowSnapshot.organizationId, authCtx.organizationId)),
                );
              publishWorkflowEvent(workflowId, "workflow.run_status_changed", {
                runId,
                dagStatus: r.status,
              });
            }
          } catch (err) {
            // 回写 workflowId 失败只记日志，不应阻塞后续清理
            logger.error(`run background workflowId update failed: runId=${runId}`, err);
          }
          // 清理本次运行启动的环境实例（独立 try-catch，避免清理失败再次抛出未捕获 rejection）
          if (r.spawnedEnvIds && r.spawnedEnvIds.length > 0) {
            try {
              await cleanupSpawnedEnvironments(new Set(r.spawnedEnvIds), authCtx.organizationId);
            } catch (err) {
              logger.error(`run background cleanup failed: runId=${runId}`, err);
            }
          }
        },
        async (err) => {
          logger.error("run background error:", err);
          if (workflowId) {
            publishWorkflowEvent(workflowId, "workflow.run_status_changed", {
              runId,
              dagStatus: "ERROR",
            });
          }
        },
      );
      return { success: true, data: { runId, status: "RUNNING" } };
    } catch (err: unknown) {
      // WorkflowError 带有 code，映射为对应 HTTP 状态码
      if (err instanceof WorkflowError) {
        const code = String(err.code);
        const status = code === "RUN_NOT_FOUND" ? 404 : code === "VALIDATION_ERROR" ? 400 : 500;
        return error(status, { success: false, error: { code, message: err.message } });
      }
      logger.error("run error:", err);
      return error(500, {
        success: false,
        error: { code: "INTERNAL_ERROR", message: (err as Error).message || "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    body: WorkflowRunRequestBodySchema,
    response: {
      200: WebOkSchema(WorkflowRunStartedSchema),
      400: WebErrSchema,
      404: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      summary: "执行工作流",
      description: "异步启动一个工作流运行，立即返回 runId。完整状态通过 getRunStatus 或 SSE 事件获取。",
      tags: ["Workflow Engine"],
    },
  },
);

// ── POST /web/workflow-runs/dry — 干运行校验 ──

app.post(
  "/workflow-runs/dry",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const engine = getTeamEngine(authCtx.organizationId);
    const deps = resolveDeps(authCtx.organizationId);
    const payload = body as typeof WorkflowDryRunRequestBodySchema._output;

    try {
      const yaml = await resolveYaml(payload, authCtx.organizationId, deps);
      if (!yaml) {
        return error(400, {
          success: false,
          error: { code: "VALIDATION_ERROR", message: "yaml or workflowId is required" },
        });
      }
      const result = engine.dryRun(yaml);
      if (payload.workflowId) {
        publishWorkflowEvent(payload.workflowId, "workflow.dry_run_completed", {
          valid: result.valid,
          issues: result.issues,
        });
      }
      return { success: true, data: result };
    } catch (err: unknown) {
      if (err instanceof WorkflowError) {
        const code = String(err.code);
        const status = code === "VALIDATION_ERROR" ? 400 : 500;
        return error(status, { success: false, error: { code, message: err.message } });
      }
      logger.error("dryRun error:", err);
      return error(500, {
        success: false,
        error: { code: "INTERNAL_ERROR", message: (err as Error).message || "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    body: WorkflowDryRunRequestBodySchema,
    response: {
      200: WebOkSchema(WorkflowDryRunResultSchema),
      400: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      summary: "干运行校验工作流",
      description: "校验工作流 YAML 的合法性并返回执行计划，不会实际执行任何节点。",
      tags: ["Workflow Engine"],
    },
  },
);

// ── POST /web/workflow-runs/:runId/cancel — 取消运行 ──

app.post(
  "/workflow-runs/:runId/cancel",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    const engine = getTeamEngine(authCtx.organizationId);
    const { runId } = params;
    const payload = body as typeof WorkflowCancelRequestBodySchema._output;

    try {
      await engine.cancel(runId);
      if (payload.workflowId) {
        publishWorkflowEvent(payload.workflowId, "workflow.run_cancelled", { runId });
        publishWorkflowEvent(payload.workflowId, "workflow.run_status_changed", {
          runId,
          dagStatus: "CANCELLED",
        });
      }
      return { success: true, data: null };
    } catch (err: unknown) {
      if (err instanceof WorkflowError) {
        const code = String(err.code);
        const status = code === "RUN_NOT_FOUND" ? 404 : 500;
        return error(status, { success: false, error: { code, message: err.message } });
      }
      logger.error("cancel error:", err);
      return error(500, {
        success: false,
        error: { code: "INTERNAL_ERROR", message: (err as Error).message || "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    params: WorkflowRunIdParamsSchema,
    body: WorkflowCancelRequestBodySchema,
    response: {
      200: WorkflowVoidSuccessSchema,
      400: WebErrSchema,
      404: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      summary: "取消运行",
      description: "取消指定的工作流运行。",
      tags: ["Workflow Engine"],
    },
  },
);

// ── POST /web/workflow-runs/:runId/approve — 审批节点 ──

app.post(
  "/workflow-runs/:runId/approve",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    const engine = getTeamEngine(authCtx.organizationId);
    const { runId } = params;
    const payload = body as typeof WorkflowApproveRequestBodySchema._output;

    try {
      await engine.approveNode(runId, payload.nodeId, payload.token, payload.data);
      if (payload.workflowId) {
        publishWorkflowEvent(payload.workflowId, "workflow.run_status_changed", {
          runId,
          dagStatus: "RUNNING",
        });
      }
      return { success: true, data: null };
    } catch (err: unknown) {
      if (err instanceof WorkflowError) {
        const code = String(err.code);
        const status = code === "RUN_NOT_FOUND" ? 404 : code === "VALIDATION_ERROR" ? 400 : 500;
        return error(status, { success: false, error: { code, message: err.message } });
      }
      logger.error("approve error:", err);
      return error(500, {
        success: false,
        error: { code: "INTERNAL_ERROR", message: (err as Error).message || "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    params: WorkflowRunIdParamsSchema,
    body: WorkflowApproveRequestBodySchema,
    response: {
      200: WorkflowVoidSuccessSchema,
      400: WebErrSchema,
      404: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      summary: "审批节点",
      description: "审批通过挂起的审批节点，使工作流继续执行。",
      tags: ["Workflow Engine"],
    },
  },
);

// ── GET /web/workflow-runs/:runId — 获取运行状态快照 ──

app.get(
  "/workflow-runs/:runId",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    const engine = getTeamEngine(authCtx.organizationId);
    const { runId } = params;

    try {
      const snapshot = await engine.getRunStatus(runId);
      return { success: true, data: snapshot };
    } catch (err: unknown) {
      if (err instanceof WorkflowError) {
        const code = String(err.code);
        const status = code === "RUN_NOT_FOUND" ? 404 : 500;
        return error(status, { success: false, error: { code, message: err.message } });
      }
      logger.error("getRunStatus error:", err);
      return error(500, {
        success: false,
        error: { code: "INTERNAL_ERROR", message: (err as Error).message || "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    params: WorkflowRunIdParamsSchema,
    response: {
      200: WebOkSchema(WorkflowDagSnapshotSchema.nullable().describe("运行状态快照；不存在时为 null。")),
      400: WebErrSchema,
      404: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      summary: "获取运行状态",
      description: "获取指定工作流运行的完整状态快照，包括各节点的状态和退出码。",
      tags: ["Workflow Engine"],
    },
  },
);

// ── GET /web/workflow-runs/:runId/events — 获取运行事件列表 ──

app.get(
  "/workflow-runs/:runId/events",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, query, error }: any) => {
    const authCtx = store.authContext!;
    const engine = getTeamEngine(authCtx.organizationId);
    const { runId } = params;
    const { nodeId } = query;

    try {
      const events = await engine.getEvents(runId, { nodeId });
      return { success: true, data: events };
    } catch (err: unknown) {
      if (err instanceof WorkflowError) {
        const code = String(err.code);
        const status = code === "RUN_NOT_FOUND" ? 404 : 500;
        return error(status, { success: false, error: { code, message: err.message } });
      }
      logger.error("getEvents error:", err);
      return error(500, {
        success: false,
        error: { code: "INTERNAL_ERROR", message: (err as Error).message || "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    params: WorkflowRunIdParamsSchema,
    query: WorkflowEventsQuerySchema,
    response: {
      200: WebOkSchema(WorkflowDagEventSchema.array().describe("运行事件列表。")),
      400: WebErrSchema,
      404: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      summary: "获取运行事件列表",
      description: "获取指定工作流运行的全部事件记录，支持按 nodeId 可选项过滤。",
      tags: ["Workflow Engine"],
    },
  },
);

// ── GET /web/workflow-runs/:runId/nodes/:nodeId/output — 获取节点输出 ──

app.get(
  "/workflow-runs/:runId/nodes/:nodeId/output",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    const engine = getTeamEngine(authCtx.organizationId);
    const { runId, nodeId } = params;

    try {
      const output = await engine.getOutput(runId, nodeId);
      return { success: true, data: output };
    } catch (err: unknown) {
      if (err instanceof WorkflowError) {
        const code = String(err.code);
        const status = code === "RUN_NOT_FOUND" ? 404 : 500;
        return error(status, { success: false, error: { code, message: err.message } });
      }
      logger.error("getOutput error:", err);
      return error(500, {
        success: false,
        error: { code: "INTERNAL_ERROR", message: (err as Error).message || "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    params: WorkflowRunNodeParamsSchema,
    response: {
      200: WebOkSchema(WorkflowNodeOutputSchema.nullable().describe("节点输出；尚未产生时为 null。")),
      400: WebErrSchema,
      404: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      summary: "获取节点输出",
      description: "获取指定运行中某个节点的 stdout / JSON / exit_code 输出。",
      tags: ["Workflow Engine"],
    },
  },
);

// ── GET /web/workflow-runs/:runId/approvals — 获取待审批列表 ──

app.get(
  "/workflow-runs/:runId/approvals",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    const engine = getTeamEngine(authCtx.organizationId);
    const { runId } = params;

    try {
      const approvals = await engine.getPendingApprovals(runId);
      return { success: true, data: approvals };
    } catch (err: unknown) {
      if (err instanceof WorkflowError) {
        const code = String(err.code);
        const status = code === "RUN_NOT_FOUND" ? 404 : 500;
        return error(status, { success: false, error: { code, message: err.message } });
      }
      logger.error("getPendingApprovals error:", err);
      return error(500, {
        success: false,
        error: { code: "INTERNAL_ERROR", message: (err as Error).message || "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    params: WorkflowRunIdParamsSchema,
    response: {
      200: WebOkSchema(WorkflowPendingApprovalSchema.array().describe("待审批节点列表。")),
      400: WebErrSchema,
      404: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      summary: "获取待审批列表",
      description: "获取指定运行中当前所有等待审批的节点列表。",
      tags: ["Workflow Engine"],
    },
  },
);

// ── POST /web/workflow-runs/:runId/recover — 从快照恢复运行 ──

app.post(
  "/workflow-runs/:runId/recover",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    const engine = getTeamEngine(authCtx.organizationId);
    const { runId } = params;
    const payload = body as typeof WorkflowRecoverRequestBodySchema._output;

    try {
      const result = await engine.recover(runId, payload.yaml);
      return { success: true, data: result };
    } catch (err: unknown) {
      if (err instanceof WorkflowError) {
        const code = String(err.code);
        const status = code === "RUN_NOT_FOUND" ? 404 : code === "VALIDATION_ERROR" ? 400 : 500;
        return error(status, { success: false, error: { code, message: err.message } });
      }
      logger.error("recover error:", err);
      return error(500, {
        success: false,
        error: { code: "INTERNAL_ERROR", message: (err as Error).message || "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    params: WorkflowRunIdParamsSchema,
    body: WorkflowRecoverRequestBodySchema,
    response: {
      200: WebOkSchema(WorkflowDagRunResultSchema),
      400: WebErrSchema,
      404: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      summary: "恢复运行",
      description: "从指定运行的快照恢复被中断的工作流执行。",
      tags: ["Workflow Engine"],
    },
  },
);

// ── POST /web/workflow-runs/:runId/rerun — 从指定节点重新运行 ──

app.post(
  "/workflow-runs/:runId/rerun",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    const engine = getTeamEngine(authCtx.organizationId);
    const { runId } = params;
    const payload = body as typeof WorkflowRerunRequestBodySchema._output;

    try {
      const result = await engine.rerunFrom(runId, payload.yaml, payload.fromNodeId);
      // 回写 workflowId 到新 run 的快照
      if (payload.workflowId) {
        await db
          .update(workflowSnapshot)
          .set({ workflowId: payload.workflowId })
          .where(
            and(eq(workflowSnapshot.runId, result.runId), eq(workflowSnapshot.organizationId, authCtx.organizationId)),
          );
        // 用真实 runId 发布事件，前端能正确响应
        publishWorkflowEvent(payload.workflowId, "workflow.run_started", { runId: result.runId });
      }
      if (payload.workflowId && result.status) {
        const terminalStatuses = ["SUCCESS", "FAILED", "CANCELLED", "ERROR"];
        if (terminalStatuses.includes(result.status)) {
          publishWorkflowEvent(payload.workflowId, "workflow.run_status_changed", {
            runId: result.runId,
            dagStatus: result.status,
          });
        }
      }
      return { success: true, data: result };
    } catch (err: unknown) {
      if (err instanceof WorkflowError) {
        const code = String(err.code);
        const status = code === "RUN_NOT_FOUND" ? 404 : code === "VALIDATION_ERROR" ? 400 : 500;
        return error(status, { success: false, error: { code, message: err.message } });
      }
      logger.error("rerun error:", err);
      return error(500, {
        success: false,
        error: { code: "INTERNAL_ERROR", message: (err as Error).message || "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    params: WorkflowRunIdParamsSchema,
    body: WorkflowRerunRequestBodySchema,
    response: {
      200: WebOkSchema(WorkflowDagRunResultSchema),
      400: WebErrSchema,
      404: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      summary: "重新运行",
      description: "从指定节点重新运行工作流，保留上游输出不变，目标节点及其下游重新执行。",
      tags: ["Workflow Engine"],
    },
  },
);

export { app as workflowRunsRoutes };
