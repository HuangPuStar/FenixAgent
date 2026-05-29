/**
 * Workflow Jobs API 路由。
 *
 * POST /web/workflow-jobs — action 分发，管理看板 Job 的创建、查询、运行、审批、删除。
 */

import { WorkflowError } from "@fenix/workflow-engine";
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { getVersionYaml, getWorkflowDef } from "../../repositories/workflow-def";
import {
  createJob,
  deleteJob,
  getJob,
  listJobs,
  updateJobParams,
  updateJobStatus,
} from "../../repositories/workflow-job";
import { getTeamEngine } from "../../services/workflow";
import { publishJobEvent } from "../../services/workflow/workflow-job-events";

const app = new Elysia({ name: "web-workflow-jobs" }).use(authGuardPlugin);

app.post(
  "/workflow-jobs",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const payload = body as Record<string, unknown>;
    const action = payload.action as string;

    try {
      switch (action) {
        // 创建 Job
        case "create": {
          const workflowId = payload.workflowId as string;
          const boardId = payload.boardId as string;
          const params = payload.params as Record<string, unknown> | undefined;
          if (!workflowId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
          }
          if (!boardId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "boardId is required" } });
          }
          const wf = await getWorkflowDef(workflowId, authCtx.organizationId);
          if (!wf) return error(404, { error: { type: "NOT_FOUND", message: "Workflow not found" } });
          const version = wf.latestVersion ?? 0;

          const job = await createJob(authCtx.organizationId, authCtx.userId, { boardId, workflowId, version, params });
          publishJobEvent(authCtx.organizationId, "job.created", { jobId: job.id });
          return { success: true, data: job };
        }

        // 列出所有 Job
        case "list": {
          const jobs = await listJobs(authCtx.organizationId);
          return { success: true, data: jobs };
        }

        // 获取单个 Job
        case "get": {
          const jobId = payload.jobId as string;
          if (!jobId) return error(400, { error: { type: "VALIDATION_ERROR", message: "jobId is required" } });
          const job = await getJob(jobId, authCtx.organizationId);
          if (!job) return error(404, { error: { type: "NOT_FOUND", message: "Job not found" } });
          return { success: true, data: job };
        }

        // 更新参数（仅 ready 状态）
        case "updateParams": {
          const jobId = payload.jobId as string;
          const params = payload.params as Record<string, unknown>;
          if (!jobId || !params) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "jobId and params are required" } });
          }
          const ok = await updateJobParams(jobId, authCtx.organizationId, params);
          if (!ok) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "Job not found or not in ready status" } });
          }
          publishJobEvent(authCtx.organizationId, "job.params_updated", { jobId });
          return { success: true };
        }

        // 删除 Job
        case "delete": {
          const jobId = payload.jobId as string;
          if (!jobId) return error(400, { error: { type: "VALIDATION_ERROR", message: "jobId is required" } });
          const job = await getJob(jobId, authCtx.organizationId);
          if (!job) return error(404, { error: { type: "NOT_FOUND", message: "Job not found" } });
          if (job.status === "running" || job.status === "suspended") {
            return error(400, {
              error: { type: "VALIDATION_ERROR", message: "Cannot delete a running or suspended job" },
            });
          }
          const deleted = await deleteJob(jobId, authCtx.organizationId);
          if (deleted) publishJobEvent(authCtx.organizationId, "job.deleted", { jobId });
          return { success: true };
        }

        // 触发运行
        case "run": {
          const jobId = payload.jobId as string;
          if (!jobId) return error(400, { error: { type: "VALIDATION_ERROR", message: "jobId is required" } });
          const job = await getJob(jobId, authCtx.organizationId);
          if (!job) return error(404, { error: { type: "NOT_FOUND", message: "Job not found" } });
          if (job.status !== "ready" && job.status !== "completed") {
            return error(400, {
              error: { type: "VALIDATION_ERROR", message: "Job must be in ready or completed status" },
            });
          }

          const yaml = await getVersionYaml(job.workflowId, job.version);
          if (!yaml) return error(400, { error: { type: "VALIDATION_ERROR", message: "Workflow YAML not found" } });

          const engine = getTeamEngine(authCtx.organizationId);
          const { runId, result } = engine.runAsync(yaml, (job.params as Record<string, unknown>) ?? undefined);

          await updateJobStatus(jobId, authCtx.organizationId, {
            status: "running",
            lastRunId: runId,
            incRunCount: true,
          });
          publishJobEvent(authCtx.organizationId, "job.started", { jobId, runId });

          // 监听 SUSPENDED 状态（轮询快照，间隔 2 秒）
          const suspendedCheck = setInterval(async () => {
            try {
              const snapshot = await engine.getRunStatus(runId);
              if (snapshot?.dag_status === "SUSPENDED") {
                clearInterval(suspendedCheck);
                await updateJobStatus(jobId, authCtx.organizationId, { status: "suspended" });
                publishJobEvent(authCtx.organizationId, "job.suspended", { jobId, runId });
              }
            } catch {
              // snapshot 可能还未就绪，忽略
            }
          }, 2000);

          // 后台：终态更新 Job
          result.finally(() => clearInterval(suspendedCheck));
          result.then(
            async (r) => {
              await updateJobStatus(jobId, authCtx.organizationId, {
                status: "completed",
                lastDagStatus: r.status,
              });
              publishJobEvent(authCtx.organizationId, "job.completed", { jobId, runId, dagStatus: r.status });
            },
            async (err) => {
              console.error("[workflow-jobs] run error:", err);
              await updateJobStatus(jobId, authCtx.organizationId, {
                status: "completed",
                lastDagStatus: "ERROR",
              });
              publishJobEvent(authCtx.organizationId, "job.completed", { jobId, runId, dagStatus: "ERROR" });
            },
          );

          return { success: true, data: { runId } };
        }

        // 取消运行
        case "cancel": {
          const jobId = payload.jobId as string;
          if (!jobId) return error(400, { error: { type: "VALIDATION_ERROR", message: "jobId is required" } });
          const job = await getJob(jobId, authCtx.organizationId);
          if (!job) return error(404, { error: { type: "NOT_FOUND", message: "Job not found" } });
          if (job.status !== "running" && job.status !== "suspended") {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "Job is not running or suspended" } });
          }

          const engine = getTeamEngine(authCtx.organizationId);
          if (job.lastRunId) await engine.cancel(job.lastRunId);

          await updateJobStatus(jobId, authCtx.organizationId, {
            status: "completed",
            lastDagStatus: "CANCELLED",
          });
          publishJobEvent(authCtx.organizationId, "job.completed", { jobId, dagStatus: "CANCELLED" });
          return { success: true };
        }

        // 获取待审批节点
        case "getPendingApprovals": {
          const jobId = payload.jobId as string;
          if (!jobId) return error(400, { error: { type: "VALIDATION_ERROR", message: "jobId is required" } });
          const job = await getJob(jobId, authCtx.organizationId);
          if (!job) return error(404, { error: { type: "NOT_FOUND", message: "Job not found" } });
          if (!job.lastRunId) return { success: true, data: [] };

          const engine = getTeamEngine(authCtx.organizationId);
          const approvals = await engine.getPendingApprovals(job.lastRunId);
          return { success: true, data: approvals };
        }

        // 审批通过
        case "approve": {
          const jobId = payload.jobId as string;
          const nodeId = payload.nodeId as string;
          const token = payload.token as string;
          const approveData = payload.data as unknown;
          if (!jobId || !nodeId || !token) {
            return error(400, {
              error: { type: "VALIDATION_ERROR", message: "jobId, nodeId and token are required" },
            });
          }
          const job = await getJob(jobId, authCtx.organizationId);
          if (!job) return error(404, { error: { type: "NOT_FOUND", message: "Job not found" } });
          if (job.status !== "suspended") {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "Job is not suspended" } });
          }

          const engine = getTeamEngine(authCtx.organizationId);
          await engine.approveNode(job.lastRunId!, nodeId, token, approveData);

          await updateJobStatus(jobId, authCtx.organizationId, { status: "running" });
          publishJobEvent(authCtx.organizationId, "job.started", { jobId });
          return { success: true };
        }

        default:
          return error(400, { error: { type: "VALIDATION_ERROR", message: `Unknown action: ${action}` } });
      }
    } catch (err: unknown) {
      if (err instanceof WorkflowError) {
        const code = String(err.code);
        const status = code === "RUN_NOT_FOUND" ? 404 : code === "VALIDATION_ERROR" ? 400 : 500;
        return error(status, { error: { type: code, message: err.message } });
      }
      console.error("[workflow-jobs] Error:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(500, { error: { type: "INTERNAL_ERROR", message } });
    }
  },
  { sessionAuth: true },
);

export default app;
