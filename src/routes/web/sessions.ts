import { Hono } from "hono";
import { sessionAuth, uuidAuth, getUuidFromRequest } from "../../auth/middleware";
import {
  storeGetSession,
  storeListSessionsByUserId,
} from "../../store";
import { getEventBus } from "../../transport/event-bus";
import { resolveExistingWebSessionId, resolveOwnedWebSessionId } from "../../services/session";

const app = new Hono();

function toSessionResponse(row: { id: string; environmentId: string | null; title: string | null; status: string; source: string; permissionMode: string | null; workerEpoch: number; username: string | null; createdAt: Date; updatedAt: Date }) {
  return {
    id: row.id,
    environment_id: row.environmentId,
    title: row.title,
    status: row.status,
    source: row.source,
    permission_mode: row.permissionMode,
    worker_epoch: row.workerEpoch,
    username: row.username,
    created_at: row.createdAt.getTime() / 1000,
    updated_at: row.updatedAt.getTime() / 1000,
  };
}

function toSessionSummary(row: { id: string; title: string | null; status: string; username: string | null; updatedAt: Date }) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    username: row.username,
    updated_at: row.updatedAt.getTime() / 1000,
  };
}

/** GET /web/sessions — List sessions owned by the current user */
app.get("/sessions", sessionAuth, async (c) => {
  const user = c.get("user")!;
  const sessions = storeListSessionsByUserId(user.id).map(toSessionResponse);
  return c.json(sessions, 200);
});

/** GET /web/sessions/all — List session summaries owned by the current user */
app.get("/sessions/all", sessionAuth, async (c) => {
  const user = c.get("user")!;
  const sessions = storeListSessionsByUserId(user.id).map(toSessionSummary);
  return c.json(sessions, 200);
});

/** GET /web/sessions/:id — Session detail */
app.get("/sessions/:id", sessionAuth, async (c) => {
  const user = c.get("user")!;
  const sessionId = c.req.param("id")!;
  const session = storeGetSession(sessionId);
  if (!session) {
    return c.json({ error: { type: "not_found", message: "Session not found" } }, 404);
  }
  if (session.userId && session.userId !== user.id) {
    return c.json({ error: { type: "forbidden", message: "Not your session" } }, 403);
  }
  return c.json(toSessionResponse(session), 200);
});

/** GET /web/sessions/:id/history — Session event history
 *  Supports both sessionAuth (cookie) and uuidAuth (?uuid=) */
app.get("/sessions/:id/history", async (c, next) => {
  // Try sessionAuth first, fall back to uuidAuth
  const uuid = getUuidFromRequest(c);
  if (uuid) {
    return uuidAuth(c, next);
  }
  return sessionAuth(c, next);
}, async (c) => {
  const sessionId = c.req.param("id")!;

  // Resolve via uuid ownership or session ownership
  let resolvedId: string | null = null;
  const uuid = c.get("uuid");
  const user = c.get("user");

  if (uuid) {
    resolvedId = resolveOwnedWebSessionId(sessionId, uuid);
  } else if (user) {
    const session = storeGetSession(sessionId);
    if (session && (!session.userId || session.userId === user.id)) {
      resolvedId = sessionId;
    }
  }

  if (!resolvedId) {
    resolvedId = resolveExistingWebSessionId(sessionId);
  }

  if (!resolvedId) {
    return c.json({ error: { type: "not_found", message: "Session not found" } }, 404);
  }

  const bus = getEventBus(resolvedId);
  const events = bus.getEventsSince(0);
  return c.json({ events }, 200);
});

export default app;
