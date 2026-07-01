/**
 * Workflow SSE 实时事件流端点。
 *
 * GET /web/workflow/:workflowId/events — 前端通过 EventSource 订阅，
 * 接收 workflow 状态变更事件。支持 Last-Event-ID / fromSeqNum 断线重连。
 */

import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { getWorkflowDef } from "../../repositories/workflow-def";
import {
  WorkflowEventStreamParamsSchema,
  WorkflowEventStreamQuerySchema,
  WorkflowStreamEventPayloadSchema,
} from "../../schemas";
import { getWorkflowEventBus } from "../../services/workflow/workflow-events";

const app = new Elysia({ name: "web-workflow-sse" }).use(authGuardPlugin).model({
  "workflow-event-stream-params": WorkflowEventStreamParamsSchema,
  "workflow-event-stream-query": WorkflowEventStreamQuerySchema,
  "workflow-stream-event-payload": WorkflowStreamEventPayloadSchema,
});

app.get(
  "/workflow/:workflowId/events",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ request, params, query, error, store }: any) => {
    const authCtx = store.authContext;
    if (!authCtx) {
      return error(401, { success: false, error: { code: "UNAUTHORIZED", message: "No auth context" } });
    }

    const workflowId = params.workflowId as string;
    if (!workflowId) {
      return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "workflowId is required" } });
    }

    // 多租户关键：校验 workflowId 归属当前 organization，防止跨组织订阅 SSE 事件流
    const wf = await getWorkflowDef(workflowId, authCtx.organizationId);
    if (!wf) {
      return error(404, { success: false, error: { code: "NOT_FOUND", message: "Workflow not found" } });
    }

    const bus = getWorkflowEventBus(workflowId);

    const lastEventId = request.headers.get("Last-Event-ID");
    const fromSeq = (query as Record<string, unknown>)?.fromSeqNum;
    const fromSeqNum = fromSeq ? Number(fromSeq) : lastEventId ? Number(lastEventId) : 0;

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": keepalive\n\n"));

        // 回放历史事件（断线重连）
        if (fromSeqNum > 0) {
          const missed = bus.getEventsSince(fromSeqNum);
          for (const event of missed) {
            const data = JSON.stringify(event.payload);
            controller.enqueue(encoder.encode(`id: ${event.seqNum}\nevent: message\ndata: ${data}\n\n`));
          }
        }

        // 订阅新事件
        const unsub = bus.subscribe((event) => {
          try {
            const data = JSON.stringify(event.payload);
            controller.enqueue(encoder.encode(`id: ${event.seqNum}\nevent: message\ndata: ${data}\n\n`));
          } catch {
            unsub();
          }
        });

        // Keepalive（15s）
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
    params: "workflow-event-stream-params",
    query: "workflow-event-stream-query",
    detail: {
      tags: ["Workflow Engine"],
      summary: "订阅工作流事件流",
      description: "通过 SSE 订阅指定工作流的实时事件，支持 `Last-Event-ID` 或 `fromSeqNum` 断线续传。",
      responses: {
        200: {
          description: "SSE 事件流，事件负载为工作流事件对象。",
          content: {
            "text/event-stream": {
              schema: {
                type: "string",
                format: "binary",
              },
              examples: {
                event: {
                  summary: "事件示例",
                  value: 'id: 12\nevent: message\ndata: {"type":"workflow.run_started","workflowId":"wf_123"}\n\n',
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
