/**
 * Workflow Definition API 路由。
 *
 * POST /web/workflow-defs — action 分发，管理工作流定义和版本。
 */

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

const app = new Elysia({ name: "web-workflow-defs" }).use(authGuardPlugin);

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
          return { success: true, data: row };
        }

        case "save": {
          const workflowId = payload.workflowId as string;
          const yaml = payload.yaml as string;
          if (!workflowId || !yaml) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId and yaml are required" } });
          }
          await saveDraft(workflowId, authCtx, yaml);
          return { success: true };
        }

        case "publish": {
          const workflowId = payload.workflowId as string;
          if (!workflowId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
          }
          const vRow = await publishVersion(workflowId, authCtx);
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
          const draftYaml = await getVersionYaml(workflowId, 0);
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
          return { success: true };
        }

        default:
          return error(400, { error: { type: "VALIDATION_ERROR", message: `Unknown action: ${action}` } });
      }
    } catch (err: unknown) {
      console.error("[workflow-defs] Error:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(500, { error: { type: "INTERNAL_ERROR", message } });
    }
  },
  { sessionAuth: true },
);

export default app;
