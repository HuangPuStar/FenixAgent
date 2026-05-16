import Elysia from "elysia";
import { errorResponse } from "../../plugins/auth";
import { resolveExistingSessionId, bindSessionOwner } from "../../services/session";

const BindSessionRequestSchema = {
  sessionId: "",
  uuid: "",
};

const app = new Elysia({ name: "web-auth", prefix: "/web" })
  .decorate({ error: errorResponse });

/** POST /web/bind — Bind a session to a UUID (no-login auth) */
app.post("/bind", async ({ body, query, error }) => {
  const b = body as { sessionId?: string; uuid?: string };
  const sessionId = b.sessionId;
  const uuid = (query as any)?.uuid || b.uuid;

  if (!sessionId || !uuid) {
    return error(400, { error: "sessionId and uuid are required" });
  }

  const resolvedSessionId = await resolveExistingSessionId(sessionId);
  if (!resolvedSessionId) {
    return error(404, { error: "Session not found" });
  }

  await bindSessionOwner(resolvedSessionId, uuid);
  return { ok: true, sessionId: resolvedSessionId };
});

export default app;
