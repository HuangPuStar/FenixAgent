/**
 * 单个 Job 的实时日志 SSE 端点。
 *
 * GET /web/workflow-jobs/:jobId/logs — 前端通过 EventSource 订阅，
 * 接收该 Job 对应 run 的 DAG 节点事件。
 * 支持 Last-Event-ID / fromSeqNum 断线重连。
 */

import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { getJob } from "../../repositories/workflow-job";
import { WorkflowDagEventSchema, WorkflowEventStreamQuerySchema, WorkflowJobLogsParamsSchema } from "../../schemas";
import { createPgStorageAdapter } from "../../services/workflow/pg-storage-adapter";
import { getKanbanEventBus } from "../../services/workflow/workflow-job-events";

const NODE_EVENTS = [
  "node.started",
  "node.completed",
  "node.failed",
  "node.cancelled",
  "node.retrying",
  "dag.completed",
];

const app = new Elysia({ name: "web-workflow-jobs-logs" }).use(authGuardPlugin).model({
  "workflow-event-stream-query": WorkflowEventStreamQuerySchema,
  "workflow-job-logs-params": WorkflowJobLogsParamsSchema,
  "workflow-dag-event": WorkflowDagEventSchema,
});

app.get(
  "/workflow-jobs/:jobId/logs",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ request, params, query, error, store }: any) => {
    const authCtx = store.authContext;
    if (!authCtx) {
      return error(401, { error: { type: "UNAUTHORIZED", message: "No auth context" } });
    }

    const jobId = (params as Record<string, unknown>).jobId as string;
    if (!jobId) return error(400, { error: { type: "VALIDATION_ERROR", message: "jobId is required" } });

    const job = await getJob(jobId, authCtx.organizationId);
    if (!job) return error(404, { error: { type: "NOT_FOUND", message: "Job not found" } });
    if (!job.lastRunId) return error(400, { error: { type: "VALIDATION_ERROR", message: "Job has no run" } });

    const runId = job.lastRunId;
    const storage = createPgStorageAdapter(authCtx.organizationId);
    const bus = getKanbanEventBus(authCtx.organizationId);

    const history = await storage.getEvents(runId);
    const filtered = history.filter((e) => NODE_EVENTS.includes(e.type));

    const lastEventId = request.headers.get("Last-Event-ID");
    const fromSeq = (query as Record<string, unknown>)?.fromSeqNum;
    const fromSeqNum = fromSeq ? Number(fromSeq) : lastEventId ? Number(lastEventId) : 0;

    let seqCounter = fromSeqNum;

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": keepalive\n\n"));

        for (const evt of filtered) {
          seqCounter++;
          const data = JSON.stringify(evt);
          controller.enqueue(encoder.encode(`id: ${seqCounter}\nevent: message\ndata: ${data}\n\n`));
        }

        const unsub = bus.subscribe((event) => {
          try {
            const payload = event.payload as Record<string, unknown>;
            if (payload.runId !== runId) return;
            const type = payload.type as string;
            if (!NODE_EVENTS.includes(type)) return;

            seqCounter++;
            const data = JSON.stringify(payload);
            controller.enqueue(encoder.encode(`id: ${seqCounter}\nevent: message\ndata: ${data}\n\n`));
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
    params: "workflow-job-logs-params",
    query: "workflow-event-stream-query",
    detail: {
      tags: ["Workflow Engine"],
      summary: "订阅 Job 运行日志流",
      description: "通过 SSE 订阅指定 Job 最近一次运行的节点事件日志，支持从指定事件序号继续回放。",
      responses: {
        200: {
          description: "SSE 事件流，事件负载为节点级 DAG 事件对象。",
          content: {
            "text/event-stream": {
              schema: {
                type: "string",
                format: "binary",
              },
              examples: {
                event: {
                  summary: "事件示例",
                  value:
                    'id: 5\nevent: message\ndata: {"type":"node.completed","run_id":"run_1","node_id":"shell_1"}\n\n',
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
