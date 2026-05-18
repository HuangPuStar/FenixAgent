/**
 * Workflow Engine API 路由。
 *
 * 通过 POST /web/workflow-engine + action 分发，提供工作流的执行、取消、审批、状态查询等能力。
 * listRuns 直接调用 StorageAdapter（不走引擎门面）。
 */

import Elysia from "elysia";
import { WorkflowError } from "@mothership/workflow-engine";
import { authGuardPlugin } from "../../plugins/auth";
import { loadTeamContext } from "../../services/team-context";
import { getTeamEngine } from "../../services/workflow";
import { createPgStorageAdapter } from "../../services/workflow/pg-storage-adapter";

const app = new Elysia({ name: "web-workflow-engine", prefix: "/web" }).use(authGuardPlugin);

// POST /web/workflow-engine — action 分发
app.post(
  "/workflow-engine",
  async ({ store, body, error, request }: any) => {
    const authCtx = (await loadTeamContext(store.user!, request as any))!;
    const payload = body as Record<string, unknown>;
    const action = payload.action as string;
    const engine = getTeamEngine(authCtx.teamId);

    try {
      switch (action) {
        // 执行工作流
        case "run": {
          const yaml = payload.yaml as string;
          const params = payload.params as Record<string, unknown> | undefined;
          const result = await engine.run(yaml, params);
          return { success: true, data: result };
        }

        // 干运行：校验 + 展示执行计划
        case "dryRun": {
          const yaml = payload.yaml as string;
          const result = engine.dryRun(yaml);
          return { success: true, data: result };
        }

        // 取消运行
        case "cancel": {
          const runId = payload.runId as string;
          await engine.cancel(runId);
          return { success: true };
        }

        // 审批节点
        case "approve": {
          const runId = payload.runId as string;
          const nodeId = payload.nodeId as string;
          const token = payload.token as string;
          const data = payload.data as unknown;
          await engine.approveNode(runId, nodeId, token, data);
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
          const storage = createPgStorageAdapter(authCtx.teamId);
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
