import { OrchestrationError } from "@fenix/orchestration";
import { ApiV1ErrSchema, ApiV1OkSchema, AppError } from "@fenix/platform-sdk";
import { SandboxProviderNotConfiguredError, SandboxRuntimeNotReadyError } from "@fenix/resource-sandbox/server";
import Elysia from "elysia";
import * as z from "zod/v4";
import { mapOrchestrationErrorToHttp } from "../../errors/orchestration-http";
import {
  ApiInstanceAgentConfigParamsSchema,
  type ApiInstanceConnectBody,
  ApiInstanceConnectBodySchema,
  ApiInstanceConnectResponseSchema,
  ApiInstanceDetailSchema,
  ApiInstanceIdParamsSchema,
  ApiInstanceListQuerySchema,
  ApiInstanceListResponseSchema,
} from "../../schemas/api-instance.schema";
import {
  connectAgentInstance,
  type InstanceOwner,
  listApiInstances,
  restartApiInstance,
  stopApiInstance,
  toApiInstanceDetail,
} from "../../server/services/api-instance";
import { getApiOwnedInstance } from "../../server/services/api-instance-resolution";
import type { ApiInstanceRouteDependencies } from "../dependencies";

const ApiErrorResponseSchema = ApiV1ErrSchema;

function mapApiError(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  // Sandbox 服务不可用类错误：Provider 未配置 / Runtime 未就绪 → 503，保持对外
  // API 语义（外部客户端区分"服务暂不可用"与"内部错误"）。
  // message 固定文案：SandboxRuntimeNotReadyError 携带 sbi_* sandboxId、
  // SandboxProviderNotConfiguredError 携带 providerKey（main 遗留透传），
  // 直出会向外部 API Key 调用方泄漏内部资源标识；完整诊断由 handler 的
  // logError 保留在服务端日志（与 OrchestrationError 分支脱敏口径统一）。
  if (error instanceof SandboxProviderNotConfiguredError || error instanceof SandboxRuntimeNotReadyError) {
    return {
      status: 503,
      body: {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Sandbox service is unavailable",
        },
      },
    };
  }
  // OrchestrationError 不是 AppError（无 statusCode 字段），此前落入兜底 500 并
  // 原样返回 message（D-P2.2）。这里统一经编排域映射（src/errors/orchestration-http.ts，
  // 与 errorPlugin 共用单一真相来源）：status 按错误码映射，message 用通用模板
  // 替换 —— 编排域错误可能携带 envId/machineId（如 ConcurrencyExceededError 拼接
  // 环境 ID），直出会泄漏内部资源标识；code 保留机器码供外部客户端分类。
  if (error instanceof OrchestrationError) {
    const { status, message } = mapOrchestrationErrorToHttp(error);
    return { status, body: { error: { code: error.code, message } } };
  }
  if (error instanceof Error && "statusCode" in error && "code" in error) {
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    const code = typeof error.code === "string" ? error.code : "INTERNAL_ERROR";
    return { status: statusCode, body: { error: { code, message: error.message } } };
  }
  // 兜底不再拼接 error.message：CoreRuntimeError 等未知错误可能携带
  // nodeId/machineId（如 "Core node is offline: ${nodeId}"），原样返回会泄漏
  // 内部标识；完整诊断由调用方（route）的服务端日志保留。
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
  };
}

/**
 * `/api/v1/agents/:id/instances/connect` 路由工厂。
 *
 * 两个宿主依赖（CE 阶段 2 任务 1.4 W2）：会话守卫必须与宿主 `/web/*` 路由是同一份实例（Elysia 的
 * macro / state 是实例作用域的，包内自建一份会让同一进程出现两套互不可见的认证状态）；`logError` 是
 * 宿主请求日志管道的 onError 钩子，要读宿主中间件写入的 requestId 与耗时，包内没有它们的来源。
 */
export function createApiInstanceRoutes(deps: ApiInstanceRouteDependencies) {
  const app = new Elysia({ name: "api-instances", prefix: "/api/v1" }).use(deps.authGuardPlugin).model({
    "api-instance-agent-params": ApiInstanceAgentConfigParamsSchema,
    "api-instance-connect-body": ApiInstanceConnectBodySchema,
    "api-instance-connect-response": ApiV1OkSchema(ApiInstanceConnectResponseSchema),
  });

  app.post(
    "/agents/:id/instances/connect",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
    async ({ store, params, body, error, set, request }: any) => {
      // store.authContext 由注入的守卫写入（宿主 `AuthContext`）；这里按连接入口真正消费的两个字段
      // （组织 + 用户）收窄。可见性判定由 agent-config 按该用户的真实成员关系完成（§9.1），本层不再
      // 转发 `role`——曾经转发的伪造角色会让读出来的 `access.actions` 虚高。
      const authCtx = store.authContext as InstanceOwner;
      try {
        return {
          success: true,
          data: await connectAgentInstance(authCtx, params.id, {
            ...(body as ApiInstanceConnectBody),
            signal: request.signal,
          }),
        };
      } catch (err) {
        const mapped = mapApiError(err);
        // 先记录最终状态再返回映射响应：诊断信息（如 sandboxId/providerKey）只进
        // 服务端日志，不出现在对外响应体（与 errorPlugin 的映射+日志顺序约定一致）
        set.status = mapped.status;
        deps.logError({ request, error: err, set });
        return error(mapped.status, { success: false, ...mapped.body });
      }
    },
    {
      sessionAuth: true,
      params: "api-instance-agent-params",
      body: "api-instance-connect-body",
      response: {
        200: "api-instance-connect-response",
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        422: ApiErrorResponseSchema,
        500: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["External Instance"],
        summary: "连接 Agent Instance",
        description: "根据 Agent 配置定位并准备一个可连接的实例，必要时自动创建 environment 和启动实例。",
      },
    },
  );

  app.onError(({ error, set }) => {
    if (error instanceof AppError) {
      set.status = error.statusCode;
      return {
        success: false as const,
        error: { code: error.code, message: error.statusCode >= 500 ? "Internal server error" : error.message },
      };
    }
  });
  app.get(
    "/agents/:id/instances",
    async ({ store, params, query }) => ({
      success: true as const,
      data: await listApiInstances(store.authContext as InstanceOwner, params.id, query),
    }),
    {
      sessionAuth: true,
      params: ApiInstanceAgentConfigParamsSchema,
      query: ApiInstanceListQuerySchema,
      response: { 200: ApiV1OkSchema(ApiInstanceListResponseSchema), 401: ApiV1ErrSchema, 404: ApiV1ErrSchema },
      detail: { tags: ["External Instance"], summary: "查询 Agent 的现有实例" },
    },
  );
  app.get(
    "/instances/:id",
    async ({ store, params }) => ({
      success: true as const,
      data: toApiInstanceDetail(await getApiOwnedInstance(store.authContext as InstanceOwner, params.id)),
    }),
    {
      sessionAuth: true,
      params: ApiInstanceIdParamsSchema,
      response: { 200: ApiV1OkSchema(ApiInstanceDetailSchema), 401: ApiV1ErrSchema, 404: ApiV1ErrSchema },
      detail: { tags: ["External Instance"], summary: "查询现有实例" },
    },
  );
  app.post(
    "/instances/:id/stop",
    async ({ store, params }) => ({
      success: true as const,
      data: await stopApiInstance(store.authContext as InstanceOwner, params.id),
    }),
    {
      sessionAuth: true,
      params: ApiInstanceIdParamsSchema,
      response: { 200: ApiV1OkSchema(z.null()), 401: ApiV1ErrSchema, 404: ApiV1ErrSchema, 409: ApiV1ErrSchema },
      detail: { tags: ["External Instance"], summary: "严格停止实例" },
    },
  );
  app.post(
    "/instances/:id/restart",
    async ({ store, params }) => ({
      success: true as const,
      data: await restartApiInstance(store.authContext as InstanceOwner, params.id),
    }),
    {
      sessionAuth: true,
      params: ApiInstanceIdParamsSchema,
      response: {
        200: ApiV1OkSchema(ApiInstanceDetailSchema),
        401: ApiV1ErrSchema,
        404: ApiV1ErrSchema,
        409: ApiV1ErrSchema,
      },
      detail: { tags: ["External Instance"], summary: "重启实例" },
    },
  );
  return app;
}
