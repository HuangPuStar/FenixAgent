import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { CodeSessionIdParamsSchema, StatusOkResponseSchema } from "../../schemas";
import {
  WorkerEventsRequestSchema,
  WorkerEventsResponseSchema,
  type WorkerStateRequest,
  WorkerStateRequestSchema,
  WorkerStateResponseSchema,
} from "../../schemas/v2-worker-events.schema";
import { getSession, updateSessionStatus } from "../../services/session";
import { publishSessionEvent } from "../../services/transport";

const app = new Elysia({ name: "v1-code-sessions-worker-events", prefix: "/v1/code/sessions" })
  .use(authGuardPlugin)
  .model({
    "code-session-id-params": CodeSessionIdParamsSchema,
    "worker-events-request": WorkerEventsRequestSchema,
    "worker-events-response": WorkerEventsResponseSchema,
    "worker-state-request": WorkerStateRequestSchema,
    "worker-state-response": WorkerStateResponseSchema,
    "status-ok-response": StatusOkResponseSchema,
  });

function extractWorkerEvents(body: unknown): Array<Record<string, unknown>> {
  if (!body || typeof body !== "object") {
    return [];
  }

  const payload = body as Record<string, unknown>;
  const rawEvents = Array.isArray(payload.events) ? payload.events : Array.isArray(body) ? body : [body];

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
app.post(
  "/:id/worker/events",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ params, body, error }: any) => {
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
  },
  {
    sessionIngressAuth: true,
    params: "code-session-id-params",
    body: "worker-events-request",
    response: "worker-events-response",
    detail: {
      tags: ["Code Session"],
      summary: "写入 Worker 事件",
      description: "向指定 Code Session 发布 worker 事件。支持单条事件、事件数组或带 `events` 字段的批量上报。",
    },
  },
);

/** PUT /v1/code/sessions/:id/worker/state — Report worker state */
app.put(
  "/:id/worker/state",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ params, body, error }: any) => {
    const sessionId = params.id;
    if (!getSession(sessionId)) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }
    const b = body as WorkerStateRequest;

    if (b.status) {
      updateSessionStatus(sessionId, b.status);
    }

    return { status: "ok" };
  },
  {
    sessionIngressAuth: true,
    params: "code-session-id-params",
    body: "worker-state-request",
    response: "worker-state-response",
    detail: {
      tags: ["Code Session"],
      summary: "同步 Worker 状态",
      description: "将 worker 当前状态同步到会话状态字段。",
    },
  },
);

/** PUT /v1/code/sessions/:id/worker/external_metadata — Report worker metadata (no-op) */
app.put(
  "/:id/worker/external_metadata",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ params, error }: any) => {
    const sessionId = params.id;
    if (!getSession(sessionId)) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }
    // TUI's CCRClient calls this for metadata reporting. Accept and discard.
    return { status: "ok" };
  },
  {
    sessionIngressAuth: true,
    params: "code-session-id-params",
    response: "status-ok-response",
    detail: {
      tags: ["Code Session"],
      summary: "上报 Worker 外部元数据",
      description: "兼容旧客户端的元数据上报接口。当前服务端接受请求但不持久化内容。",
    },
  },
);

/** POST /v1/code/sessions/:id/worker/events/delivery — Batch delivery tracking (no-op) */
app.post(
  "/:id/worker/events/delivery",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ params, error }: any) => {
    const sessionId = params.id;
    if (!getSession(sessionId)) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }
    return { status: "ok" };
  },
  {
    sessionIngressAuth: true,
    params: "code-session-id-params",
    response: "status-ok-response",
    detail: {
      tags: ["Code Session"],
      summary: "批量回执事件投递状态",
      description: "兼容旧客户端的批量事件投递回执接口。当前服务端接受请求但不追踪投递状态。",
    },
  },
);

/** POST /v1/code/sessions/:id/worker/events/:eventId/delivery — Delivery tracking (no-op) */
app.post(
  "/:id/worker/events/:eventId/delivery",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ params, error }: any) => {
    const sessionId = params.id;
    if (!getSession(sessionId)) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }
    // TUI's CCRClient reports event delivery status (received/processing/processed).
    // Accept and discard — event bus doesn't track per-event delivery.
    return { status: "ok" };
  },
  {
    sessionIngressAuth: true,
    params: "code-session-id-params",
    response: "status-ok-response",
    detail: {
      tags: ["Code Session"],
      summary: "回执单条事件投递状态",
      description: "兼容旧客户端的单事件投递回执接口。当前服务端接受请求但不追踪投递状态。",
    },
  },
);

export default app;
