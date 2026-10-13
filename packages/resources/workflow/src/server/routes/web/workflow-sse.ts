/**
 * Workflow SSE 实时事件流端点。
 *
 * GET /web/workflow/:workflowId/events — 前端通过 EventSource 订阅，
 * 接收 workflow 状态变更事件。支持 Last-Event-ID / fromSeqNum 断线重连。
 *
 * 连接态留在路由的原因（数据取数已收敛到 `workflowDefFacade`，连接本身不收敛）：订阅、回放与释放在
 * 同一条 `ReadableStream` 的生命周期内完成——`unsub` / `keepalive` / `abort` 三者必须成对出现，
 * 跨层拆分会让「谁负责关流」变得不可判定，也无法保证 `controller.enqueue` 抛错时解绑订阅。
 * 边界是：路由只持有连接与事件总线句柄；工作流归属仍经 Facade 校验（组织来自认证上下文）。
 */

import Elysia from "elysia";
import { workflowDefFacade } from "../../facades/workflow-def-facade";
import {
  WorkflowEventStreamParamsSchema,
  WorkflowEventStreamQuerySchema,
  WorkflowStreamEventPayloadSchema,
} from "../../schemas";
import { getWorkflowEventBus } from "../../services/workflow/workflow-events";

import type { WorkflowRouteDependencies } from "../dependencies";

export function createWebWorkflowSseRoutes(deps: WorkflowRouteDependencies) {
  const app = new Elysia({ name: "web-workflow-sse" }).use(deps.authGuardPlugin).model({
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

      // 多租户关键：校验 workflowId 归属当前 organization，防止跨组织订阅 SSE 事件流。
      // 组织范围由 Facade 从认证上下文推导（路由不再自己拼组织条件）；跨组织与不存在同样回 404，
      // 不给出「资源存在但无权」的可探测信号。
      const wf = await workflowDefFacade.get(authCtx, workflowId);
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
                // 字面量必须用 `as const` 钉住：守卫类型刻意放宽为 `AnyElysia`（见 ../dependencies.ts 的理由），
                // 此时 `app.get` 的 detail 上下文类型不再是精确的 OpenAPI 结构，`type: "string"` 会被推断成
                // 宽化的 `string` 而报 TS2322。
                schema: {
                  type: "string" as const,
                  format: "binary" as const,
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

  return app;
}
