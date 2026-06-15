/**
 * 看板 SSE 实时事件流端点。
 *
 * GET /web/workflow-jobs/events — 前端通过 EventSource 订阅，
 * 接收当前组织所有 Job 的状态变更事件。
 * 支持 Last-Event-ID / fromSeqNum 断线重连。
 */

import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { WorkflowEventStreamQuerySchema, WorkflowJobStreamEventPayloadSchema } from "../../schemas";
import { getKanbanEventBus } from "../../services/workflow/workflow-job-events";

const app = new Elysia({ name: "web-workflow-jobs-sse" }).use(authGuardPlugin).model({
  "workflow-event-stream-query": WorkflowEventStreamQuerySchema,
  "workflow-job-stream-event-payload": WorkflowJobStreamEventPayloadSchema,
});

app.get(
  "/workflow-jobs/events",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ request, query, error, store }: any) => {
    const authCtx = store.authContext;
    if (!authCtx) {
      return error(401, { error: { type: "UNAUTHORIZED", message: "No auth context" } });
    }

    const bus = getKanbanEventBus(authCtx.organizationId);

    const lastEventId = request.headers.get("Last-Event-ID");
    const fromSeq = (query as Record<string, unknown>)?.fromSeqNum;
    const fromSeqNum = fromSeq ? Number(fromSeq) : lastEventId ? Number(lastEventId) : 0;

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": keepalive\n\n"));

        if (fromSeqNum > 0) {
          const missed = bus.getEventsSince(fromSeqNum);
          for (const event of missed) {
            const data = JSON.stringify(event.payload);
            controller.enqueue(encoder.encode(`id: ${event.seqNum}\nevent: message\ndata: ${data}\n\n`));
          }
        }

        const unsub = bus.subscribe((event) => {
          try {
            const data = JSON.stringify(event.payload);
            controller.enqueue(encoder.encode(`id: ${event.seqNum}\nevent: message\ndata: ${data}\n\n`));
          } catch {
            unsub();
          }
        });

        const keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            clearInterval(keepalive);
            unsub();
          }
        }, 15_000);

        request.signal.addEventListener("abort", () => {
          unsub();
          clearInterval(keepalive);
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  },
  {
    sessionAuth: true,
    query: "workflow-event-stream-query",
    detail: {
      tags: ["Workflow Engine"],
      summary: "订阅 Job 看板事件流",
      description: "通过 SSE 订阅当前组织下所有工作流 Job 的状态变更事件，支持断线续传。",
      responses: {
        200: {
          description: "SSE 事件流，事件负载为 Job 变更事件对象。",
          content: {
            "text/event-stream": {
              schema: {
                type: "string",
                format: "binary",
              },
              examples: {
                event: {
                  summary: "事件示例",
                  value: 'id: 34\nevent: message\ndata: {"type":"job.started","jobId":"job_123","runId":"run_456"}\n\n',
                },
              },
            },
          },
        },
      },
    },
  },
);

export default app;
