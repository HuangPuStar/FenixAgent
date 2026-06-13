import Elysia from "elysia";
import * as z from "zod/v4";
import { type AuthContext, authGuardPlugin } from "../../plugins/auth";
import {
  ApiInstanceAgentConfigParamsSchema,
  type ApiInstanceConnectBody,
  ApiInstanceConnectBodySchema,
  ApiInstanceConnectResponseSchema,
} from "../../schemas/api-instance.schema";
import { connectAgentInstance } from "../../services/api-instance";

const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().describe("错误码。"),
    message: z.string().describe("错误描述。"),
  }),
});

function mapApiError(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (error instanceof Error && "statusCode" in error && "code" in error) {
    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    const code = typeof error.code === "string" ? error.code : "INTERNAL_ERROR";
    return { status: statusCode, body: { error: { code, message: error.message } } };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Unknown error" } },
  };
}

const app = new Elysia({ name: "api-instances", prefix: "/api" }).use(authGuardPlugin).model({
  "api-instance-agent-params": ApiInstanceAgentConfigParamsSchema,
  "api-instance-connect-body": ApiInstanceConnectBodySchema,
  "api-instance-connect-response": ApiInstanceConnectResponseSchema,
});

app.post(
  "/agents/:agentConfigId/instances/connect",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    try {
      return await connectAgentInstance(authCtx, params.agentConfigId, body as ApiInstanceConnectBody);
    } catch (err) {
      const mapped = mapApiError(err);
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
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Instance"],
      summary: "连接 Agent Instance",
      description: "根据 Agent 配置定位并准备一个可连接的实例，必要时自动创建 environment 和启动实例。",
    },
  },
);

export default app;
