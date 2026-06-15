import Elysia from "elysia";
import { generateWorkerJwt } from "../../auth/jwt";
import { config, getBaseUrl } from "../../config";
import { authGuardPlugin } from "../../plugins/auth";
import { requireOrgScope } from "../../plugins/require-team-scope";
import { environmentRepo, sessionRepo } from "../../repositories";
import {
  CodeSessionBridgeResponseSchema,
  CodeSessionIdParamsSchema,
  type CreateCodeSessionRequest,
  CreateCodeSessionRequestSchema,
  CreateCodeSessionResponseSchema,
} from "../../schemas";
import { createSession, getSession } from "../../services/session";

const app = new Elysia({ name: "v1-code-sessions", prefix: "/v1/code/sessions" }).use(authGuardPlugin).model({
  "create-code-session-request": CreateCodeSessionRequestSchema,
  "create-code-session-response": CreateCodeSessionResponseSchema,
  "code-session-id-params": CodeSessionIdParamsSchema,
  "code-session-bridge-response": CodeSessionBridgeResponseSchema,
});

/** POST /v1/code/sessions — Create code session (wrapped response for TUI compat) */
app.post(
  "/",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, body, error }: any) => {
    const authContext = store.authContext;
    if (!authContext) {
      return error(403, { error: { type: "forbidden", message: "No organization context" } });
    }
    const b = body as CreateCodeSessionRequest;
    const session = await createSession({ ...b, source: "code", userId: authContext.userId });
    return { session };
  },
  {
    apiKeyAuth: true,
    body: "create-code-session-request",
    response: "create-code-session-response",
    detail: {
      tags: ["Code Session"],
      summary: "创建 Code Session",
      description: "创建一个供 TUI 或 worker 使用的 Code Session，并返回兼容旧客户端的包装响应。",
    },
  },
);

/** POST /v1/code/sessions/:id/bridge — Get connection info + worker JWT */
app.post(
  "/:id/bridge",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, params, error }: any) => {
    const authContext = store.authContext;
    if (!authContext) {
      return error(403, { error: { type: "forbidden", message: "No organization context" } });
    }
    const sessionId = params.id;
    const session = await getSession(sessionId);
    if (!session) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }

    // 校验 session 归属：session → environment → team
    const sessionRecord = await sessionRepo.getById(sessionId);
    if (sessionRecord?.environmentId) {
      const env = await environmentRepo.getById(sessionRecord.environmentId);
      if (env) {
        const denied = requireOrgScope(authContext, env.organizationId);
        if (denied) return denied;
      }
    }

    const expiresInSeconds = config.jwtExpiresIn;
    const workerJwt = generateWorkerJwt(sessionId, expiresInSeconds);

    return {
      api_base_url: getBaseUrl(),
      worker_jwt: workerJwt,
      expires_in: expiresInSeconds,
    };
  },
  {
    apiKeyAuth: true,
    params: "code-session-id-params",
    response: "code-session-bridge-response",
    detail: {
      tags: ["Code Session"],
      summary: "获取 Session Bridge 连接信息",
      description: "为指定 Code Session 生成 worker 接入所需的 API 地址和短期 JWT。",
    },
  },
);

export default app;
