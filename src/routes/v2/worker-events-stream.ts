import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { CodeSessionIdParamsSchema } from "../../schemas";
import { getSession } from "../../services/session";
import { createWorkerEventStream } from "../../transport/sse-writer";

const app = new Elysia({ name: "v1-code-sessions-worker-events-stream", prefix: "/v1/code/sessions" })
  .use(authGuardPlugin)
  .model({
    "code-session-id-params": CodeSessionIdParamsSchema,
  });

/** SSE /v1/code/sessions/:id/worker/events/stream — SSE event stream */
app.get(
  "/:id/worker/events/stream",
  async ({ request, params, query, error }) => {
    const sessionId = params.id;
    const session = getSession(sessionId);
    if (!session) {
      return error(404, { error: { type: "not_found", message: "Session not found" } });
    }

    // Support Last-Event-ID / from_sequence_num for reconnection
    const lastEventId = request.headers.get("Last-Event-ID");
    // biome-ignore lint/suspicious/noExplicitAny: query params are dynamic in Elysia
    const fromSeq = (query as any)?.from_sequence_num;
    const fromSeqNum = fromSeq ? parseInt(fromSeq, 10) : lastEventId ? parseInt(lastEventId, 10) : 0;

    return createWorkerEventStream(request, sessionId, fromSeqNum);
  },
  {
    sessionIngressAuth: true,
    params: "code-session-id-params",
    detail: {
      tags: ["Code Session"],
      summary: "订阅 Worker 事件流",
      description:
        "通过 SSE 订阅指定 Code Session 的 worker 事件流。支持 `Last-Event-ID` 或 `from_sequence_num` 断线续传。",
      responses: {
        200: {
          description: "SSE 事件流。",
          content: {
            "text/event-stream": {
              schema: {
                type: "string",
                format: "binary",
              },
            },
          },
        },
      },
    },
  },
);

export default app;
