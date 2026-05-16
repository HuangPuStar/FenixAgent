import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { publishSessionEvent } from "../../services/transport";
import { getSession, updateSessionStatus } from "../../services/session";
import { WorkerEventsRequestSchema, WorkerStateRequestSchema, type WorkerStateRequest } from "../../schemas/v2-worker-events.schema";

const app = new Elysia({ name: "v1-code-sessions-worker-events", prefix: "/v1/code/sessions" })
  .use(authGuardPlugin)
  .model({
    "worker-events-request": WorkerEventsRequestSchema,
    "worker-state-request": WorkerStateRequestSchema,
  });

function extractWorkerEvents(body: unknown): Array<Record<string, unknown>> {
  if (!body || typeof body !== "object") {
    return [];
  }

  const payload = body as Record<string, unknown>;
  const rawEvents = Array.isArray(payload.events)
    ? payload.events
    : Array.isArray(body)
      ? body
      : [body];

  return rawEvents
    .filter((evt): evt is Record<string, unknown> => !!evt && typeof evt === "object")
    .map((evt) => {
      const wrappedPayload = evt.payload;
      if (wrappedPayload && typeof wrappedPayload === "object" && !Array.isArray(wrappedPayload)) {
        return wrappedPayload as Record<string, unknown>;
      }
      return evt;
    });
}

/** POST /v1/code/sessions/:id/worker/events — Write events */
app.post("/:id/worker/events", async ({ params, body, error }) => {
  const sessionId = params.id;
  if (!getSession(sessionId)) {
    return error(404, { error: { type: "not_found", message: "Session not found" } });
  }

  const events = extractWorkerEvents(body);
  const published = [];
  for (const evt of events) {
    const eventType = typeof evt.type === "string" ? evt.type : "message";
    const result = publishSessionEvent(sessionId, eventType, evt, "inbound");
    published.push(result);
  }

  return { status: "ok", count: published.length };
}, { sessionIngressAuth: true, body: "worker-events-request" });

/** PUT /v1/code/sessions/:id/worker/state — Report worker state */
app.put("/:id/worker/state", async ({ params, body, error }) => {
  const sessionId = params.id;
  if (!getSession(sessionId)) {
    return error(404, { error: { type: "not_found", message: "Session not found" } });
  }
  const b = body as WorkerStateRequest;

  if (b.status) {
    updateSessionStatus(sessionId, b.status);
  }

  return { status: "ok" };
}, { sessionIngressAuth: true, body: "worker-state-request" });

/** PUT /v1/code/sessions/:id/worker/external_metadata — Report worker metadata (no-op) */
app.put("/:id/worker/external_metadata", async ({ params, error }) => {
  const sessionId = params.id;
  if (!getSession(sessionId)) {
    return error(404, { error: { type: "not_found", message: "Session not found" } });
  }
  // TUI's CCRClient calls this for metadata reporting. Accept and discard.
  return { status: "ok" };
}, { sessionIngressAuth: true });

/** POST /v1/code/sessions/:id/worker/events/delivery — Batch delivery tracking (no-op) */
app.post("/:id/worker/events/delivery", async ({ params, error }) => {
  const sessionId = params.id;
  if (!getSession(sessionId)) {
    return error(404, { error: { type: "not_found", message: "Session not found" } });
  }
  return { status: "ok" };
}, { sessionIngressAuth: true });

/** POST /v1/code/sessions/:id/worker/events/:eventId/delivery — Delivery tracking (no-op) */
app.post("/:id/worker/events/:eventId/delivery", async ({ params, error }) => {
  const sessionId = params.id;
  if (!getSession(sessionId)) {
    return error(404, { error: { type: "not_found", message: "Session not found" } });
  }
  // TUI's CCRClient reports event delivery status (received/processing/processed).
  // Accept and discard — event bus doesn't track per-event delivery.
  return { status: "ok" };
}, { sessionIngressAuth: true });

export default app;
