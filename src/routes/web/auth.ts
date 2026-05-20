import Elysia from "elysia";
import { authGuardPlugin, errorResponse } from "../../plugins/auth";
import { bindSessionOwner, resolveExistingSessionId } from "../../services/session";
import { loadOrgContext } from "../../services/org-context";

const app = new Elysia({ name: "web-auth", prefix: "/web" }).use(authGuardPlugin).decorate({ error: errorResponse });

/** POST /web/bind — Bind a session to a user (requires session auth) */
app.post(
  "/bind",
  async ({ store, body, query, error, request }) => {
    const user = store.user;
    if (!user) {
      return error(401, { error: "Not authenticated" });
    }

    const b = body as { sessionId?: string; uuid?: string };
    const sessionId = b.sessionId;
    const uuid = (query as any)?.uuid || b.uuid;

    if (!sessionId || !uuid) {
      return error(400, { error: "sessionId and uuid are required" });
    }

    const authCtx = await loadOrgContext(user, request);
    if (!authCtx) {
      return error(403, { error: "No team context" });
    }

    const resolvedSessionId = await resolveExistingSessionId(sessionId);
    if (!resolvedSessionId) {
      return error(404, { error: "Session not found" });
    }

    await bindSessionOwner(resolvedSessionId, uuid);
    return { ok: true, sessionId: resolvedSessionId };
  },
  { sessionAuth: true },
);

export default app;
