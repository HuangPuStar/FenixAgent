import Elysia from "elysia";
import { authGuardPlugin, errorResponse } from "../../plugins/auth";
import { BindSessionQuerySchema, BindSessionRequestSchema, BindSessionResponseSchema } from "../../schemas";
import { bindSessionOwner, resolveExistingSessionId } from "../../services/session";

const app = new Elysia({ name: "web-auth" }).use(authGuardPlugin).decorate({ error: errorResponse }).model({
  "bind-session-body": BindSessionRequestSchema,
  "bind-session-query": BindSessionQuerySchema,
  "bind-session-response": BindSessionResponseSchema,
});

/** POST /web/bind — 绑定会话归属关系（需要会话鉴权） */
app.post(
  "/bind",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, body, query, error }: any) => {
    const user = store.user;
    if (!user) {
      return error(401, { error: "Not authenticated" });
    }

    const b = body as { sessionId?: string; uuid?: string };
    const sessionId = b.sessionId;
    const uuid = (query as Record<string, string | undefined>)?.uuid || b.uuid;

    if (!sessionId || !uuid) {
      return error(400, { error: "sessionId and uuid are required" });
    }

    const authCtx = store.authContext;
    if (!authCtx) {
      return error(403, { error: "No organization context" });
    }

    const resolvedSessionId = await resolveExistingSessionId(sessionId);
    if (!resolvedSessionId) {
      return error(404, { error: "Session not found" });
    }

    await bindSessionOwner(resolvedSessionId, uuid);
    return { ok: true, sessionId: resolvedSessionId };
  },
  {
    sessionAuth: true,
    body: "bind-session-body",
    query: "bind-session-query",
    response: "bind-session-response",
    detail: {
      tags: ["Auth"],
      summary: "绑定会话归属",
      description:
        "将指定会话绑定到用户标识上。当前兼容两种 uuid 传参方式：优先读取 query.uuid，缺失时再回退到 body.uuid。",
      parameters: [
        {
          name: "uuid",
          in: "query",
          required: false,
          description: "待绑定的用户唯一标识；优先于 body.uuid 使用。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

export default app;
