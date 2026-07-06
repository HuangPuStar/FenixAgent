/**
 * 外部 Workflow 执行 API 路由。
 *
 * 提供 POST /api/workflows/:workflowId/execute 端点，
 * 允许外部系统通过 API Key 调用已发布的工作流并获取执行结果。
 */

import { WorkflowError } from "@fenix/workflow-engine";
import Elysia from "elysia";
import { z } from "zod/v4";
import { type AuthContext, authGuardPlugin } from "../../plugins/auth";
import { ApiErrorResponseSchema } from "../../schemas/api-common.schema";
import {
  ApiWorkflowAuthorizationHeadersSchema,
  ApiWorkflowExecuteAsyncSchema,
  ApiWorkflowExecuteFailedSchema,
  ApiWorkflowExecuteRequestBodySchema,
  ApiWorkflowExecuteSuccessNoOutputSchema,
  ApiWorkflowExecuteSuccessWithOutputSchema,
  ApiWorkflowExecuteTimeoutSchema,
  ApiWorkflowIdParamsSchema,
} from "../../schemas/api-workflow.schema";
import { executeWorkflow } from "../../services/workflow/workflow-execute";

const app = new Elysia({ name: "api-workflows" }).use(authGuardPlugin);

app.post(
  "/api/workflows/:workflowId/execute",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
  async ({ store, params, body, status }: any) => {
    const authCtx = store.authContext as AuthContext;
    const { workflowId } = params;
    const payload = body as typeof ApiWorkflowExecuteRequestBodySchema._output;

    try {
      const result = await executeWorkflow(authCtx.organizationId, workflowId, payload);
      return result;
    } catch (err: unknown) {
      if (err instanceof WorkflowError) {
        const code = String(err.code);
        if (code === "NOT_FOUND") {
          return status(404, { error: { code: "NOT_FOUND", message: "Workflow 不存在" } });
        }
        if (code === "VALIDATION_ERROR") {
          return status(422, { error: { code: "INVALID_INPUTS", message: err.message } });
        }
        return status(500, { error: { code: "INTERNAL_ERROR", message: err.message } });
      }
      console.error("[api-workflows] execute error:", err);
      return status(500, {
        error: { code: "INTERNAL_ERROR", message: (err as Error).message || "Unknown error" },
      });
    }
  },
  {
    sessionAuth: true,
    headers: ApiWorkflowAuthorizationHeadersSchema,
    params: ApiWorkflowIdParamsSchema,
    body: ApiWorkflowExecuteRequestBodySchema,
    response: {
      200: z.union([
        ApiWorkflowExecuteSuccessWithOutputSchema,
        ApiWorkflowExecuteSuccessNoOutputSchema,
        ApiWorkflowExecuteFailedSchema,
        ApiWorkflowExecuteTimeoutSchema,
        ApiWorkflowExecuteAsyncSchema,
      ]),
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      422: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Workflow"],
      summary: "执行工作流",
      description:
        "执行指定工作流并返回结果。支持同步模式（等待完成返回结果）和异步模式（立即返回 runId）。" +
        "若工作流定义了 end 节点，同步成功时返回 end 节点收集的输出数据。",
    },
  },
);

export default app;
