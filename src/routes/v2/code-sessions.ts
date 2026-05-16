import Elysia from "elysia";
import { createSession, getSession } from "../../services/session";
import { authGuardPlugin } from "../../plugins/auth";
import { generateWorkerJwt } from "../../auth/jwt";
import { getBaseUrl, config } from "../../config";
import { CreateCodeSessionRequestSchema, type CreateCodeSessionRequest } from "../../schemas/v2-code-session.schema";

const app = new Elysia({ name: "v1-code-sessions", prefix: "/v1/code/sessions" })
  .use(authGuardPlugin)
  .model({ "create-code-session-request": CreateCodeSessionRequestSchema });

/** POST /v1/code/sessions — Create code session (wrapped response for TUI compat) */
app.post("/", async ({ body }) => {
  const b = body as CreateCodeSessionRequest;
  const session = await createSession({ ...b, source: "code" });
  return { session };
}, { apiKeyAuth: true, body: "create-code-session-request" });

/** POST /v1/code/sessions/:id/bridge — Get connection info + worker JWT */
app.post("/:id/bridge", async ({ params, error }) => {
  const sessionId = params.id;
  const session = await getSession(sessionId);
  if (!session) {
    return error(404, { error: { type: "not_found", message: "Session not found" } });
  }

  const expiresInSeconds = config.jwtExpiresIn;
  const workerJwt = generateWorkerJwt(sessionId, expiresInSeconds);

  return {
    api_base_url: getBaseUrl(),
    worker_epoch: 0,
    worker_jwt: workerJwt,
    expires_in: expiresInSeconds,
  };
}, { apiKeyAuth: true });

export default app;
