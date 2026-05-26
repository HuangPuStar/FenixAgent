/**
 * Workflow SSE 实时事件流端点。
 *
 * GET /web/workflow/:workflowId/events — 前端通过 EventSource 订阅，
 * 接收 workflow 状态变更事件。支持 Last-Event-ID / fromSeqNum 断线重连。
 */

import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { getWorkflowEventBus } from "../../services/workflow/workflow-events";

const app = new Elysia({ name: "web-workflow-sse" }).use(authGuardPlugin);

app.get(
  "/workflow/:workflowId/events",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ request, params, query, error, store }: any) => {
    const authCtx = store.authContext;
    if (!authCtx) {
      return error(401, { error: { type: "UNAUTHORIZED", message: "No auth context" } });
    }

    const workflowId = params.workflowId as string;
    if (!workflowId) {
      return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
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
  { sessionAuth: true },
);

export default app;
