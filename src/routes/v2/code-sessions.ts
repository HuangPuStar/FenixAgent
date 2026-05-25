import Elysia from "elysia";
import { generateWorkerJwt } from "../../auth/jwt";
import { config, getBaseUrl } from "../../config";
import { authGuardPlugin } from "../../plugins/auth";
import { requireOrgScope } from "../../plugins/require-team-scope";
import { environmentRepo, sessionRepo } from "../../repositories";
import { type CreateCodeSessionRequest, CreateCodeSessionRequestSchema } from "../../schemas/v2-code-session.schema";
import { createSession, getSession } from "../../services/session";

const app = new Elysia({ name: "v1-code-sessions", prefix: "/v1/code/sessions" })
  .use(authGuardPlugin)
  .model({ "create-code-session-request": CreateCodeSessionRequestSchema });

/** POST /v1/code/sessions — Create code session (wrapped response for TUI compat) */
app.post(
  "/",
  async ({ store, body, error }) => {
    const authContext = store.authContext;
    if (!authContext) {
      return error(403, { error: { type: "forbidden", message: "No organization context" } });
    }
    const b = body as CreateCodeSessionRequest;
    const session = await createSession({ ...b, source: "code", userId: authContext.userId });
    return { session };
  },
  { apiKeyAuth: true, body: "create-code-session-request" },
);

/** POST /v1/code/sessions/:id/bridge — Get connection info + worker JWT */
app.post(
  "/:id/bridge",
  async ({ store, params, error }) => {
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
  { apiKeyAuth: true },
);

export default app;
