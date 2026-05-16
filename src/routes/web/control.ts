import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { log, error as logError } from "../../logger";
import { getSession, resolveExistingSessionId, updateSessionStatus } from "../../services/session";
import { publishSessionEvent } from "../../services/transport";
import { eventService } from "../../services/event-service";
import { SessionEventPayloadSchema } from "../../schemas/session.schema";

const app = new Elysia({ name: "web-control", prefix: "/web" })
  .use(authGuardPlugin)
  .model({
    "session-event-payload": SessionEventPayloadSchema,
  });

type OwnershipCheckResult =
  | { error: true }
  | { error: false; session: NonNullable<Awaited<ReturnType<typeof getSession>>>; sessionId: string };

async function checkOwnership(uuid: string | null, sessionId: string): Promise<OwnershipCheckResult> {
  if (!uuid) return { error: true };
  const resolvedSessionId = await resolveExistingSessionId(sessionId);
  if (!resolvedSessionId) {
    return { error: true };
  }
  const session = await getSession(resolvedSessionId);
  if (!session) {
    return { error: true };
  }
  return { error: false, session, sessionId: resolvedSessionId };
}

/** POST /web/sessions/:id/events — Send user message to session */
app.post("/sessions/:id/events", async ({ store, params, body, error }) => {
  const requestedSessionId = params.id;
  const uuid = store.uuid;
  const ownership = await checkOwnership(uuid, requestedSessionId);
  if (ownership.error) {
    return error(403, { error: { type: "forbidden", message: "Not your session" } });
  }
  const { sessionId } = ownership;

  const b = body as { type?: string; [key: string]: unknown };
  const eventType = b.type || "user";
  log(`[RC-DEBUG] web -> server: POST /web/sessions/${sessionId}/events type=${eventType} content=${JSON.stringify(b).slice(0, 200)}`);
  const event = publishSessionEvent(sessionId, eventType, b, "outbound");
  log(`[RC-DEBUG] web -> server: published outbound event id=${event.id} type=${event.type} direction=${event.direction} subscribers=${eventService.getBus(sessionId).subscriberCount()}`);
  return { status: "ok" as const, event };
}, { uuidAuth: true, body: "session-event-payload" });

/** POST /web/sessions/:id/control — Send control request (permission approval etc) */
app.post("/sessions/:id/control", async ({ store, params, body, error }) => {
  const requestedSessionId = params.id;
  const uuid = store.uuid;
  const ownership = await checkOwnership(uuid, requestedSessionId);
  if (ownership.error) {
    return error(403, { error: { type: "forbidden", message: "Not your session" } });
  }
  const { sessionId } = ownership;

  const b = body as { type?: string; [key: string]: unknown };
  const event = publishSessionEvent(sessionId, b.type || "control_request", b, "outbound");
  return { status: "ok" as const, event };
}, { uuidAuth: true, body: "session-event-payload" });

/** POST /web/sessions/:id/interrupt — Interrupt session */
app.post("/sessions/:id/interrupt", async ({ store, params, error }) => {
  const requestedSessionId = params.id;
  const uuid = store.uuid;
  const ownership = await checkOwnership(uuid, requestedSessionId);
  if (ownership.error) {
    return error(403, { error: { type: "forbidden", message: "Not your session" } });
  }
  const { sessionId } = ownership;

  publishSessionEvent(sessionId, "interrupt", { action: "interrupt" }, "outbound");
  await updateSessionStatus(sessionId, "idle");
  return { status: "ok" as const };
}, { uuidAuth: true });

export default app;
