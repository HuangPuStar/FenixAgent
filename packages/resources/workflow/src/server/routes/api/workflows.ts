/**
 * 外部 Workflow 执行 API 路由。
 *
 * 提供 POST /api/workflows/:workflowId/execute 端点，
 * 允许外部系统通过 API Key 调用已发布的工作流并获取执行结果。
 *
 * 改为工厂：守卫必须与宿主的认证解析是同一份实例（Elysia 的 `macro` / `state` 是实例作用域的，
 * 父实例无法向已构造的子实例回填），因此由宿主注入 `authGuardPlugin`。
 */

import { ApiErrorResponseSchema } from "@fenix/platform-sdk";
import { WorkflowError } from "@fenix/workflow-engine";
import Elysia from "elysia";
import { z } from "zod/v4";
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
import type { WorkflowActorContext, WorkflowRouteDependencies } from "../dependencies";

/** 创建 `/api/workflows/*` 外部执行 API 路由。 */
export function createApiWorkflowRoutes(deps: WorkflowRouteDependencies) {
  const app = new Elysia({ name: "api-workflows" }).use(deps.authGuardPlugin);

  app.post(
    "/api/workflows/:workflowId/execute",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    async ({ store, params, body, status }: any) => {
      const authCtx = store.authContext as WorkflowActorContext;
      const { workflowId } = params;
      const payload = body as typeof ApiWorkflowExecuteRequestBodySchema._output;

      try {
        // C-P2.5：透传 API Key 调用方的真实 userId，实例计入该用户配额桶
        const result = await executeWorkflow(authCtx.organizationId, workflowId, payload, authCtx.userId);
        return result;
      } catch (err: unknown) {
        if (err instanceof WorkflowError) {
          const code = String(err.code);
          if (code === "NOT_FOUND") {
            return status(404, { error: { code: "NOT_FOUND", message: "Workflow 不存在" } });
          }
          if (code === "VALIDATION_ERROR") {
            return status(422, { error: { code: "INVALID_INPUTS", message: "Workflow inputs are invalid" } });
          }
          console.error("[api-workflows] workflow execution error:", err);
          return status(500, { error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
        }
        console.error("[api-workflows] execute error:", err);
        return status(500, {
          error: { code: "INTERNAL_ERROR", message: "Internal server error" },
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

  return app;
}
