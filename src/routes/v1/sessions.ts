import { log, error as logError } from "../../logger";
import Elysia from "elysia";
import {
  createSession,
  getSession,
  archiveSession,
  resolveExistingSessionId,
} from "../../services/session";
import { createWorkItem } from "../../services/work-dispatch";
import { authGuardPlugin } from "../../plugins/auth";
import { publishSessionEvent } from "../../services/transport";
import {
  CreateSessionRequestSchema,
  UpdateSessionRequestSchema,
  SendEventsRequestSchema,
  type CreateSessionRequest,
  type UpdateSessionRequest,
  type SendEventsRequest,
} from "../../schemas/v1-session.schema";

const app = new Elysia({ name: "v1-sessions", prefix: "/v1/sessions" })
  .use(authGuardPlugin)
  .model({
    "create-session-request": CreateSessionRequestSchema,
    "update-session-request": UpdateSessionRequestSchema,
    "send-events-request": SendEventsRequestSchema,
  });

/** POST /v1/sessions — Create session */
app.post("/", async ({ store, body }) => {
  const b = body as CreateSessionRequest;
  const username = (store as any).username as string | undefined;
  const session = await createSession({ ...b, username });

  // Create work item if environment is specified
  if (b.environment_id) {
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
}, { apiKeyAuth: true, body: "create-session-request" });

/** GET /v1/sessions/:id — Get session */
app.get("/:id", async ({ params, error }) => {
  const sessionId = await resolveExistingSessionId(params.id) ?? params.id;
  const session = await getSession(sessionId);
  if (!session) {
    return error(404, { error: { type: "not_found", message: "Session not found" } });
  }
  return session;
}, { apiKeyAuth: true });

/** PATCH /v1/sessions/:id — Update session title (no-op, title managed by Agent) */
app.patch("/:id", async ({ params, error }) => {
  const sessionId = await resolveExistingSessionId(params.id) ?? params.id;
  const session = await getSession(sessionId);
  if (!session) {
    return error(404, { error: { type: "not_found", message: "Session not found" } });
  }
  return session;
}, { apiKeyAuth: true, body: "update-session-request" });

/** POST /v1/sessions/:id/archive — Archive session */
app.post("/:id/archive", async ({ params, error }) => {
  const sessionId = await resolveExistingSessionId(params.id) ?? params.id;
  const session = await getSession(sessionId);
  if (!session) {
    return error(404, { error: { type: "not_found", message: "Session not found" } });
  }

  try {
    await archiveSession(sessionId);
  } catch {
    return { status: "ok" };
  }

  return { status: "ok" };
}, { apiKeyAuth: true });

/** POST /v1/sessions/:id/events — Send event to session */
app.post("/:id/events", async ({ params, body, error }) => {
  const sessionId = await resolveExistingSessionId(params.id) ?? params.id;
  const session = await getSession(sessionId);
  if (!session) {
    return error(404, { error: { type: "not_found", message: "Session not found" } });
  }
  const b = body as SendEventsRequest;

  const events = b.events
    ? Array.isArray(b.events) ? b.events : [b.events]
    : [];
  const published = [];
  for (const evt of events) {
    const evtType = typeof evt.type === "string" ? evt.type : "message";
    const result = publishSessionEvent(sessionId, evtType, evt, "inbound");
    published.push(result);
  }

  return { status: "ok", events: published.length };
}, { apiKeyAuth: true, body: "send-events-request" });

export default app;
