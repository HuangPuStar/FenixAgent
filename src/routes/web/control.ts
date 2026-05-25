import Elysia from "elysia";
import { log } from "../../logger";
import { authGuardPlugin } from "../../plugins/auth";
import { environmentRepo, sessionRepo } from "../../repositories";
import { SessionEventPayloadSchema } from "../../schemas/session.schema";
import { eventService } from "../../services/event-service";
import { getSession, resolveExistingSessionId, updateSessionStatus } from "../../services/session";
import { publishSessionEvent } from "../../services/transport";

const app = new Elysia({ name: "web-control" }).use(authGuardPlugin).model({
  "session-event-payload": SessionEventPayloadSchema,
});

type OwnershipCheckResult =
  | { error: true; response: Response }
  | { error: false; session: NonNullable<Awaited<ReturnType<typeof getSession>>>; sessionId: string };

async function checkOwnership(
  userId: string | null,
  orgId: string | null,
  sessionId: string,
  errorFn: (code: number, body: unknown) => Response,
): Promise<OwnershipCheckResult> {
  if (!userId || !orgId) {
    return { error: true, response: errorFn(403, { error: { type: "forbidden", message: "Not authenticated" } }) };
  }
  const resolvedSessionId = await resolveExistingSessionId(sessionId);
  if (!resolvedSessionId) {
    return { error: true, response: errorFn(404, { error: { type: "not_found", message: "Session not found" } }) };
  }
  // 验证 session 所属环境属于当前组织
  const session = await sessionRepo.getById(resolvedSessionId);
  if (!session) {
    return { error: true, response: errorFn(404, { error: { type: "not_found", message: "Session not found" } }) };
  }
  if (session.environmentId) {
    const env = await environmentRepo.getById(session.environmentId);
    if (env?.organizationId && env.organizationId !== orgId) {
      return {
        error: true,
        response: errorFn(403, { error: { type: "forbidden", message: "Not your organization's session" } }),
      };
    }
  }
  const activeSession = await getSession(resolvedSessionId);
  if (!activeSession) {
    return { error: true, response: errorFn(404, { error: { type: "not_found", message: "Session not active" } }) };
  }
  return { error: false, session: activeSession, sessionId: resolvedSessionId };
}

/** POST /web/sessions/:id/events — Send user message to session */
app.post(
  "/sessions/:id/events",
  async ({ store, params, body, error }) => {
    const requestedSessionId = params.id;
    const userId = store.user?.id ?? null;
    const orgId = store.authContext?.organizationId ?? null;
    const ownership = await checkOwnership(userId, orgId, requestedSessionId, error);
    if (ownership.error) {
      return ownership.response;
    }
    const { sessionId } = ownership;

    const b = body as { type?: string; [key: string]: unknown };
    const eventType = b.type || "user";
    log(
      `[RC-DEBUG] web -> server: POST /web/sessions/${sessionId}/events type=${eventType} content=${JSON.stringify(b).slice(0, 200)}`,
    );
    const event = publishSessionEvent(sessionId, eventType, b, "outbound");
    log(
      `[RC-DEBUG] web -> server: published outbound event id=${event.id} type=${event.type} direction=${event.direction} subscribers=${eventService.getBus(sessionId).subscriberCount()}`,
    );
    return { status: "ok" as const, event };
  },
  { sessionAuth: true, body: "session-event-payload" },
);

/** POST /web/sessions/:id/control — Send control request (permission approval etc) */
app.post(
  "/sessions/:id/control",
  async ({ store, params, body, error }) => {
    const requestedSessionId = params.id;
    const userId = store.user?.id ?? null;
    const orgId = store.authContext?.organizationId ?? null;
    const ownership = await checkOwnership(userId, orgId, requestedSessionId, error);
    if (ownership.error) {
      return ownership.response;
    }
    const { sessionId } = ownership;

    const b = body as { type?: string; [key: string]: unknown };
    const event = publishSessionEvent(sessionId, b.type || "control_request", b, "outbound");
    return { status: "ok" as const, event };
  },
  { sessionAuth: true, body: "session-event-payload" },
);

/** POST /web/sessions/:id/interrupt — Interrupt session */
app.post(
  "/sessions/:id/interrupt",
  async ({ store, params, error }) => {
    const requestedSessionId = params.id;
    const userId = store.user?.id ?? null;
    const orgId = store.authContext?.organizationId ?? null;
    const ownership = await checkOwnership(userId, orgId, requestedSessionId, error);
    if (ownership.error) {
      return ownership.response;
    }
    const { sessionId } = ownership;

    publishSessionEvent(sessionId, "interrupt", { action: "interrupt" }, "outbound");
    await updateSessionStatus(sessionId, "idle");
    return { status: "ok" as const };
  },
  { sessionAuth: true },
);

export default app;
