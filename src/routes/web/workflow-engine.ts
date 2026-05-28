/**
 * Workflow Engine API 路由。
 *
 * 通过 POST /web/workflow-engine + action 分发，提供工作流的执行、取消、审批、状态查询等能力。
 * listRuns 直接调用 StorageAdapter（不走引擎门面）。
 */

import { WorkflowError } from "@fenix/workflow-engine";
import { and, eq } from "drizzle-orm";
import Elysia from "elysia";
import { db } from "../../db";
import { workflowSnapshot } from "../../db/schema";
import { authGuardPlugin } from "../../plugins/auth";
import { cleanupSpawnedEnvironments, getTeamEngine } from "../../services/workflow";
import { createPgStorageAdapter } from "../../services/workflow/pg-storage-adapter";
import { publishWorkflowEvent } from "../../services/workflow/workflow-events";

const app = new Elysia({ name: "web-workflow-engine" }).use(authGuardPlugin);

// POST /web/workflow-engine — action 分发
app.post(
  "/workflow-engine",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const payload = body as Record<string, unknown>;
    const action = payload.action as string;
    const engine = getTeamEngine(authCtx.organizationId);

    try {
      switch (action) {
        // 执行工作流（异步启动，立即返回 runId）
        case "run": {
          const yaml = payload.yaml as string;
          const params = payload.params as Record<string, unknown> | undefined;
          const workflowId = payload.workflowId as string | undefined;
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
                      and(
                        eq(workflowSnapshot.runId, runId),
                        eq(workflowSnapshot.organizationId, authCtx.organizationId),
                      ),
                    );
                  publishWorkflowEvent(workflowId, "workflow.run_status_changed", {
                    runId,
                    dagStatus: r.status,
                  });
                }
              } finally {
                // 清理本次运行启动的环境实例
                if (r.spawnedEnvIds && r.spawnedEnvIds.length > 0) {
                  await cleanupSpawnedEnvironments(new Set(r.spawnedEnvIds), authCtx.organizationId);
                }
              }
            },
            async (err) => {
              console.error("[workflow-engine] run background error:", err);
              if (workflowId) {
                publishWorkflowEvent(workflowId, "workflow.run_status_changed", {
                  runId,
                  dagStatus: "ERROR",
                });
              }
            },
          );
          return { success: true, data: { runId, status: "RUNNING" } };
        }

        // 干运行：校验 + 展示执行计划
        case "dryRun": {
          const yaml = payload.yaml as string;
          const result = engine.dryRun(yaml);
          const dryRunWorkflowId = payload.workflowId as string | undefined;
          if (dryRunWorkflowId) {
            publishWorkflowEvent(dryRunWorkflowId, "workflow.dry_run_completed", {
              valid: result.valid,
              issues: result.issues,
            });
          }
          return { success: true, data: result };
        }

        // 取消运行
        case "cancel": {
          const runId = payload.runId as string;
          const cancelWorkflowId = payload.workflowId as string | undefined;
          await engine.cancel(runId);
          if (cancelWorkflowId) {
            publishWorkflowEvent(cancelWorkflowId, "workflow.run_cancelled", { runId });
            publishWorkflowEvent(cancelWorkflowId, "workflow.run_status_changed", {
              runId,
              dagStatus: "CANCELLED",
            });
          }
          return { success: true };
        }

        // 审批节点
        case "approve": {
          const runId = payload.runId as string;
          const nodeId = payload.nodeId as string;
          const token = payload.token as string;
          const data = payload.data as unknown;
          await engine.approveNode(runId, nodeId, token, data);
          const approveWorkflowId = payload.workflowId as string | undefined;
          if (approveWorkflowId) {
            publishWorkflowEvent(approveWorkflowId, "workflow.run_status_changed", {
              runId,
              dagStatus: "RUNNING",
            });
          }
          return { success: true };
        }

        // 获取运行状态快照
        case "getRunStatus": {
          const runId = payload.runId as string;
          const snapshot = await engine.getRunStatus(runId);
          return { success: true, data: snapshot };
        }

        // 获取事件流
        case "getEvents": {
          const runId = payload.runId as string;
          const nodeId = payload.nodeId as string | undefined;
          const events = await engine.getEvents(runId, { nodeId });
          return { success: true, data: events };
        }

        // 获取节点输出
        case "getOutput": {
          const runId = payload.runId as string;
          const nodeId = payload.nodeId as string;
          const output = await engine.getOutput(runId, nodeId);
          return { success: true, data: output };
        }

        // 获取待审批列表
        case "getPendingApprovals": {
          const runId = payload.runId as string;
          const approvals = await engine.getPendingApprovals(runId);
          return { success: true, data: approvals };
        }

        // 列出运行记录（直接调用 StorageAdapter）
        case "listRuns": {
          const storage = createPgStorageAdapter(authCtx.organizationId);
          const runs = await storage.listRuns();
          return { success: true, data: runs };
        }

        // 从快照恢复运行
        case "recover": {
          const runId = payload.runId as string;
          const yaml = payload.yaml as string;
          const result = await engine.recover(runId, yaml);
          return { success: true, data: result };
        }

        // 从指定节点重新运行
        case "rerunFrom": {
          const prevRunId = payload.runId as string;
          const fromNodeId = payload.fromNodeId as string;
          const yaml = payload.yaml as string;
          const workflowId = payload.workflowId as string | undefined;
          if (workflowId) {
            publishWorkflowEvent(workflowId, "workflow.run_started", { runId: undefined });
          }
          const result = await engine.rerunFrom(prevRunId, yaml, fromNodeId);
          // 回写 workflowId 到新 run 的快照
          if (workflowId) {
            await db
              .update(workflowSnapshot)
              .set({ workflowId })
              .where(
                and(
                  eq(workflowSnapshot.runId, result.runId),
                  eq(workflowSnapshot.organizationId, authCtx.organizationId),
                ),
              );
          }
          if (workflowId && result.status) {
            const terminalStatuses = ["SUCCESS", "FAILED", "CANCELLED", "ERROR"];
            if (terminalStatuses.includes(result.status)) {
              publishWorkflowEvent(workflowId, "workflow.run_status_changed", {
                runId: result.runId,
                dagStatus: result.status,
              });
            }
          }
          return { success: true, data: result };
        }

        default:
          return error(400, { error: { type: "validation_error", message: `Unknown action: ${action}` } });
      }
    } catch (err: unknown) {
      // WorkflowError 带有 code，映射为对应 HTTP 状态码
      if (err instanceof WorkflowError) {
        const code = String(err.code);
        const status = code === "RUN_NOT_FOUND" ? 404 : code === "VALIDATION_ERROR" ? 400 : 500;
        return error(status, { error: { type: code, message: err.message } });
      }
      console.error("[workflow-engine] Unexpected error:", err);
      return error(500, { error: { type: "INTERNAL_ERROR", message: (err as Error).message || "Unknown error" } });
    }
  },
  { sessionAuth: true },
);

export default app;
