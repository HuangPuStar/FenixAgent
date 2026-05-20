import Elysia from "elysia";
import { log, error as logError } from "../../logger";
import { authGuardPlugin } from "../../plugins/auth";
import { requireOrgScope } from "../../plugins/require-team-scope";
import { environmentRepo, sessionRepo } from "../../repositories";
import {
  type CreateSessionRequest,
  CreateSessionRequestSchema,
  type SendEventsRequest,
  SendEventsRequestSchema,
  type UpdateSessionRequest,
  UpdateSessionRequestSchema,
} from "../../schemas/v1-session.schema";
import { archiveSession, createSession, getSession, resolveExistingSessionId } from "../../services/session";
import { publishSessionEvent } from "../../services/transport";
import { createWorkItem } from "../../services/work-dispatch";

const app = new Elysia({ name: "v1-sessions", prefix: "/v1/sessions" }).use(authGuardPlugin).model({
  "create-session-request": CreateSessionRequestSchema,
  "update-session-request": UpdateSessionRequestSchema,
  "send-events-request": SendEventsRequestSchema,
});

/**
 * 校验 session 归属当前认证 team。
 * 解析链路：sessionId → sessionRecord.environmentId → environment.organizationId。
 * 返回 undefined 表示通过，否则返回错误响应。
 */
async function requireSessionScope(
  authContext: any,
  sessionId: string,
  error: (code: number, body: unknown) => Response,
): Promise<Response | undefined> {
  const sessionRecord = await sessionRepo.getById(sessionId);
  if (!sessionRecord?.environmentId) {
    // session 无 environment 绑定（轻量存根）— 允许访问
    return undefined;
  }
  const env = await environmentRepo.getById(sessionRecord.environmentId);
  if (!env) return undefined;
  return requireOrgScope(authContext, env.organizationId);
}

/** POST /v1/sessions — Create session */
app.post(
  "/",
  async ({ store, body, error }) => {
    const authContext = store.authContext;
    if (!authContext) {
      return error(403, { error: { type: "forbidden", message: "No team context" } });
    }
    const b = body as CreateSessionRequest;
    const username = (store as any).username as string | undefined;
    const session = await createSession({ ...b, username, userId: authContext.userId });

    // Create work item if environment is specified
    if (b.environment_id) {
      // 校验 environment 归属
      const env = await environmentRepo.getById(b.environment_id);
      if (env) {
        const denied = requireOrgScope(authContext, env.organizationId);
        if (denied) return denied;
      }
      try {
        await createWorkItem(b.environment_id, session.id);
      } catch (err) {
        logError(`[RCS] Failed to create work item: ${(err as Error).message}`);
      }
    }

    // Publish initial events if provided
    if (b.events && Array.isArray(b.events)) {
      for (const evt of b.events) {
        const evtType = typeof evt.type === "string" ? evt.type : "init";
        publishSessionEvent(session.id, evtType, evt, "outbound");
      }
    }

    return session;
  },
  { apiKeyAuth: true, body: "create-session-request" },
);

/** GET /v1/sessions/:id — Get session */
app.get(
  "/:id",
  async ({ store, params, error }) => {
    const authContext = store.authContext;
    const sessionId = (await resolveExistingSessionId(params.id)) ?? params.id;
    const session = await getSession(sessionId);
    if (!session) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }
    const denied = await requireSessionScope(authContext, sessionId, error);
    if (denied) return denied;
    return session;
  },
  { apiKeyAuth: true },
);

/** PATCH /v1/sessions/:id — Update session title (no-op, title managed by Agent) */
app.patch(
  "/:id",
  async ({ store, params, error }) => {
    const authContext = store.authContext;
    const sessionId = (await resolveExistingSessionId(params.id)) ?? params.id;
    const session = await getSession(sessionId);
    if (!session) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }
    const denied = await requireSessionScope(authContext, sessionId, error);
    if (denied) return denied;
    return session;
  },
  { apiKeyAuth: true, body: "update-session-request" },
);

/** POST /v1/sessions/:id/archive — Archive session */
app.post(
  "/:id/archive",
  async ({ store, params, error }) => {
    const authContext = store.authContext;
    const sessionId = (await resolveExistingSessionId(params.id)) ?? params.id;
    const session = await getSession(sessionId);
    if (!session) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }
    const denied = await requireSessionScope(authContext, sessionId, error);
    if (denied) return denied;

    try {
      await archiveSession(sessionId);
    } catch {
      return { status: "ok" };
    }

    return { status: "ok" };
  },
  { apiKeyAuth: true },
);

/** POST /v1/sessions/:id/events — Send event to session */
app.post(
  "/:id/events",
  async ({ store, params, body, error }) => {
    const authContext = store.authContext;
    const sessionId = (await resolveExistingSessionId(params.id)) ?? params.id;
    const session = await getSession(sessionId);
    if (!session) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }
    const denied = await requireSessionScope(authContext, sessionId, error);
    if (denied) return denied;

    const b = body as SendEventsRequest;

    const events = b.events ? (Array.isArray(b.events) ? b.events : [b.events]) : [];
    const published = [];
    for (const evt of events) {
      const evtType = typeof evt.type === "string" ? evt.type : "message";
      const result = publishSessionEvent(sessionId, evtType, evt, "inbound");
      published.push(result);
    }

    return { status: "ok", events: published.length };
  },
  { apiKeyAuth: true, body: "send-events-request" },
);

export default app;
