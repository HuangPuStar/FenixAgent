import { OrchestrationError } from "@fenix/orchestration";
import Elysia from "elysia";
import * as z from "zod/v4";
import { mapOrchestrationErrorToHttp } from "../../errors/orchestration-http";
import { type AuthContext, authGuardPlugin } from "../../plugins/auth";
import { logError } from "../../plugins/logger";
import {
  ApiInstanceAgentConfigParamsSchema,
  type ApiInstanceConnectBody,
  ApiInstanceConnectBodySchema,
  ApiInstanceConnectResponseSchema,
} from "../../schemas/api-instance.schema";
import { connectAgentInstance } from "../../services/api-instance";
import { SandboxProviderNotConfiguredError, SandboxRuntimeNotReadyError } from "../../services/sandbox/sandbox-errors";

const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().describe("错误码。"),
    message: z.string().describe("错误描述。"),
  }),
});

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

const app = new Elysia({ name: "api-instances", prefix: "/api" }).use(authGuardPlugin).model({
  "api-instance-agent-params": ApiInstanceAgentConfigParamsSchema,
  "api-instance-connect-body": ApiInstanceConnectBodySchema,
  "api-instance-connect-response": ApiInstanceConnectResponseSchema,
});

app.post(
  "/agents/:agentId/instances/connect",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, body, error, set, request }: any) => {
    const authCtx = store.authContext as AuthContext;
    try {
      return await connectAgentInstance(authCtx, params.agentId, body as ApiInstanceConnectBody);
    } catch (err) {
      const mapped = mapApiError(err);
      // 先记录最终状态再返回映射响应：诊断信息（如 sandboxId/providerKey）只进
      // 服务端日志，不出现在对外响应体（与 errorPlugin 的映射+日志顺序约定一致）
      set.status = mapped.status;
      logError({ request, error: err, set });
      return error(mapped.status, mapped.body);
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

export default app;
