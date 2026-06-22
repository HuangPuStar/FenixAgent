/**
 * Workflow Definition API 路由。
 *
 * POST /web/workflow-defs — action 分发，管理工作流定义和版本。
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
import { WorkflowDefsActionRequestSchema, WorkflowDefsActionResponseSchema } from "../../schemas";
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

const app = new Elysia({ name: "web-workflow-defs" }).use(authGuardPlugin).model({
  "workflow-defs-action-request": WorkflowDefsActionRequestSchema,
  "workflow-defs-action-response": WorkflowDefsActionResponseSchema,
});

app.post(
  "/workflow-defs",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;

    const payload = body as Record<string, unknown>;
    const action = payload.action as string;

    try {
      switch (action) {
        case "create": {
          const name = payload.name as string;
          const description = payload.description as string | undefined;
          if (!name?.trim()) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "name is required" } });
          }
          const row = await createWorkflowDef(authCtx, { name: name.trim(), description });
          publishWorkflowEvent(row.id, "workflow.created", {});
          return { success: true, data: row };
        }

        case "save": {
          const workflowId = payload.workflowId as string;
          const yaml = payload.yaml as string;
          if (!workflowId || !yaml) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId and yaml are required" } });
          }
          await saveDraft(workflowId, authCtx, yaml);
          publishWorkflowEvent(workflowId, "workflow.draft_updated", { yaml });
          return { success: true };
        }

        case "publish": {
          const workflowId = payload.workflowId as string;
          if (!workflowId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
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
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
          const wf = await getWorkflowDef(workflowId, authCtx.organizationId);
          if (!wf) return error(404, { error: { type: "NOT_FOUND", message: "Workflow not found" } });
          const draftYaml = await getVersionYaml(workflowId, 0, wf.storagePath);
          return { success: true, data: { ...wf, draftYaml } };
        }

        case "getVersions": {
          const workflowId = payload.workflowId as string;
          if (!workflowId)
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
          const versions = await getVersions(workflowId, authCtx.organizationId);
          return { success: true, data: versions };
        }

        case "getVersion": {
          const workflowId = payload.workflowId as string;
          const version = payload.version as number;
          if (!workflowId || version === undefined) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId and version are required" } });
          }
          const yaml = await getVersionYaml(workflowId, version);
          if (!yaml) return error(404, { error: { type: "NOT_FOUND", message: "Version not found" } });
          return { success: true, data: { workflowId, version, yaml } };
        }

        case "setLatest": {
          const workflowId = payload.workflowId as string;
          const version = payload.version as number;
          if (!workflowId || version === undefined) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId and version are required" } });
          }
          await setLatestVersion(workflowId, authCtx.organizationId, version);
          return { success: true };
        }

        case "delete": {
          const workflowId = payload.workflowId as string;
          if (!workflowId)
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
          const deleted = await deleteWorkflowDef(workflowId, authCtx.organizationId);
          if (!deleted) return error(404, { error: { type: "NOT_FOUND", message: "Workflow not found" } });
          publishWorkflowEvent(workflowId, "workflow.deleted", {});
          return { success: true };
        }

        case "updateMeta": {
          const workflowId = payload.workflowId as string;
          const name = payload.name as string | undefined;
          const description = payload.description as string | undefined;
          if (!workflowId)
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
          const updated = await updateWorkflowMeta(workflowId, authCtx.organizationId, { name, description });
          if (!updated) return error(404, { error: { type: "NOT_FOUND", message: "Workflow not found" } });
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
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowIds array is required" } });
          }
          const recovered = await recoverWorkflows(authCtx, workflowIds);
          return { success: true, data: recovered };
        }

        case "restoreToDraft": {
          const workflowId = payload.workflowId as string;
          const version = payload.version as number;
          if (!workflowId || version === undefined) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId and version are required" } });
          }
          await restoreVersionToDraft(workflowId, authCtx, version);
          publishWorkflowEvent(workflowId, "workflow.draft_restored", { version });
          return { success: true };
        }

        // ── Workflow Trigger ──

        case "createTrigger": {
          const workflowId = payload.workflowId as string;
          const triggerType = (payload.type as string) || "webhook";
          const triggerConfig = payload.config as Record<string, unknown> | undefined;
          if (!workflowId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
          }
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
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
          }
          const triggers = await listTriggers(workflowId);
          return { success: true, data: triggers };
        }

        case "deleteTrigger": {
          const triggerId = payload.triggerId as string;
          if (!triggerId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "triggerId is required" } });
          }
          const deleted = await deleteTrigger(triggerId, authCtx.organizationId);
          if (!deleted) return error(404, { error: { type: "NOT_FOUND", message: "Trigger not found" } });
          return { success: true };
        }

        case "regenerateHash": {
          const triggerId = payload.triggerId as string;
          if (!triggerId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "triggerId is required" } });
          }
          const result = await regenerateHash(triggerId, authCtx.organizationId);
          if (!result) return error(404, { error: { type: "NOT_FOUND", message: "Trigger not found" } });
          return { success: true, data: result };
        }

        case "enableTrigger": {
          const triggerId = payload.triggerId as string;
          if (!triggerId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "triggerId is required" } });
          }
          const ok = await enableTrigger(triggerId, authCtx.organizationId);
          if (!ok) return error(404, { error: { type: "NOT_FOUND", message: "Trigger not found" } });
          return { success: true };
        }

        case "disableTrigger": {
          const triggerId = payload.triggerId as string;
          if (!triggerId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "triggerId is required" } });
          }
          const ok = await disableTrigger(triggerId, authCtx.organizationId);
          if (!ok) return error(404, { error: { type: "NOT_FOUND", message: "Trigger not found" } });
          return { success: true };
        }

        case "getParamDefs": {
          const workflowId = payload.workflowId as string;
          const version = payload.version as number | undefined;
          if (!workflowId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
          }

          let targetVersion = version;
          if (targetVersion === undefined) {
            const wf = await getWorkflowDef(workflowId, authCtx.organizationId);
            if (!wf) return error(404, { error: { type: "NOT_FOUND", message: "Workflow not found" } });
            targetVersion = wf.latestVersion ?? 0;
          }

          const yaml = await getVersionYaml(workflowId, targetVersion);
          if (!yaml) return error(404, { error: { type: "NOT_FOUND", message: "Version not found" } });

          let params: Record<string, unknown> = {};
          try {
            const { parseWorkflowYaml } = await import("@fenix/workflow-engine");
            const def = parseWorkflowYaml(yaml);
            params = (def.params as Record<string, unknown>) ?? {};
          } catch {
            // YAML 解析失败，返回空 params
          }

          return { success: true, data: { version: targetVersion, params } };
        }

        default:
          return error(400, { error: { type: "VALIDATION_ERROR", message: `Unknown action: ${action}` } });
      }
    } catch (err: unknown) {
      logger.error("Error:", err);
      // 从 DrizzleQueryError.cause 中提取底层 PG 错误信息
      const cause = err instanceof Error ? err.cause : null;
      const pgMessage = cause instanceof Error ? cause.message : null;
      // 唯一约束冲突 → 409 Conflict
      if (pgMessage?.includes("duplicate key") || pgMessage?.includes("unique constraint")) {
        return error(409, {
          error: { type: "CONFLICT", message: pgMessage || "Duplicate key violation" },
        });
      }
      const message = pgMessage || (err instanceof Error ? err.message : "Unknown error");
      return error(500, { error: { type: "INTERNAL_ERROR", message } });
    }
  },
  {
    sessionAuth: true,
    body: "workflow-defs-action-request",
    response: "workflow-defs-action-response",
    detail: {
      tags: ["Workflow Engine"],
      summary: "工作流定义管理",
      description:
        "通过 action 分发管理工作流定义、版本、草稿恢复、触发器和参数提取。不同 action 对应不同请求体和返回数据结构。",
    },
  },
);

export default app;
