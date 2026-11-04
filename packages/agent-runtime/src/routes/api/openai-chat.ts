import { error as logError, requestAls } from "@fenix/logger";
import { AppError } from "@fenix/platform-sdk";
import Elysia from "elysia";
import {
  OpenAIChatCompletionRequestSchema,
  OpenAIChatCompletionResponseSchema,
  OpenAIChatHeadersSchema,
  OpenAIErrorResponseSchema,
} from "../../schemas/openai-chat.schema";
import { openAgentSession } from "../../services/agent-chat-service";
import { classifyAgentTurnEvent, iterateWithSignal, waitWithSignal } from "../../services/agent-turn-events";
import { type ApiChatSessionLease, apiChatSessions } from "../../services/api-chat-session-registry";
import { adaptOpenAIHistory } from "../../services/openai-history";
import { buildOpenAIError, mapToNonStreamingResponse, mapToSSEChunks } from "../../services/openai-response-mapper";
import type { AuthContext } from "../../types/auth";
import type { AgentRuntimeAuthDependencies } from "../dependencies";

const sessionDeps = { openAgentSession };
/** Replace the package collaborator for route tests; production uses the shared session orchestration. */
export function setOpenAIChatRouteDeps(overrides: Partial<typeof sessionDeps> | null): void {
  Object.assign(sessionDeps, overrides ?? { openAgentSession });
}

/** Native SDK endpoint; platform extensions stay in HTTP headers. */
export function createOpenaiChatRoutes(deps: AgentRuntimeAuthDependencies) {
  return new Elysia({ name: "openai-chat", prefix: "/api/v1" }).use(deps.authGuardPlugin).post(
    "/chat/completions",
    async ({ body, request, store, set }) => {
      const owner = store.authContext as AuthContext;
      const handle = request.headers.get("x-session-id");
      const requestedInstance = request.headers.get("x-instance-id") ?? undefined;
      if (handle && (body.messages.length !== 1 || body.messages[0].role !== "user"))
        throw new AppError("Continuation requires exactly one user message", "VALIDATION_ERROR", 400);
      let lease: ApiChatSessionLease | undefined = handle
        ? apiChatSessions.acquire(handle, {
            organizationId: owner.organizationId,
            userId: owner.userId,
            agentConfigId: body.model,
            instanceId: requestedInstance,
          })
        : undefined;
      let succeeded = false;
      const timeout = new AbortController();
      const deadline = setTimeout(
        () => timeout.abort(new DOMException("Agent execution timeout", "TimeoutError")),
        300_000,
      );
      const clientCancel = new AbortController();
      let signal = AbortSignal.any([
        request.signal,
        timeout.signal,
        clientCancel.signal,
        ...(lease ? [lease.signal] : []),
      ]);
      let turn: Awaited<ReturnType<typeof openAgentSession>>["turn"] | undefined;
      let releasePromise: Promise<void> | undefined;
      let detachAbort = () => {};
      const release = (): Promise<void> =>
        (releasePromise ??= (async () => {
          detachAbort();
          clearTimeout(deadline);
          try {
            await turn?.dispose();
          } finally {
            if (lease) apiChatSessions.release(lease, succeeded);
          }
        })());
      try {
        const opened = await waitWithSignal(
          sessionDeps.openAgentSession({
            userId: owner.userId,
            organizationId: owner.organizationId,
            agentConfigId: body.model,
            instanceId: lease?.owner.instanceId ?? requestedInstance,
            sessionId: lease?.sessionId,
            onResolved(context) {
              if (lease) apiChatSessions.validate(lease, context);
              else lease = apiChatSessions.reserve(context);
              signal = AbortSignal.any([signal, lease.signal]);
              return lease.signal;
            },
            startSource: "interactive",
            signal,
            requestId: requestAls.getStore()?.requestId,
          }),
          signal,
          (late) => late.turn.dispose(),
        );
        turn = opened.turn;
        if (!lease) throw new Error("Missing authorized session context");
        apiChatSessions.confirm(lease, turn.sessionId);
        set.headers["X-Session-Id"] = lease.handle;
        set.headers["X-Session-Expires-At"] = new Date(lease.expiresAt).toISOString();
        set.headers["X-Instance-Id"] = opened.instanceId;
        set.headers["X-Request-Id"] = requestAls.getStore()?.requestId ?? crypto.randomUUID();
        signal.throwIfAborted();
        turn.prompt(adaptOpenAIHistory(body.messages));
        if (body.stream) {
          const iterator = mapToSSEChunks(turn.events(), body.model, signal, () => {
            succeeded = true;
          })[Symbol.asyncIterator]();
          const encoder = new TextEncoder();
          let closed = false;
          const stream = new ReadableStream<Uint8Array>(
            {
              start(controller) {
                const abort = () => {
                  if (closed) return;
                  closed = true;
                  succeeded = false;
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify(buildOpenAIError(timeout.signal.aborted ? 504 : 500, "Agent execution failed", "server_error", timeout.signal.aborted ? "AGENT_TIMEOUT" : "AGENT_EXECUTION_FAILED").body)}\n\n`,
                    ),
                  );
                  controller.close();
                  void release().catch((error) => logError("[openai] Abort cleanup failed", error));
                };
                signal.addEventListener("abort", abort, { once: true });
                detachAbort = () => signal.removeEventListener("abort", abort);
                if (signal.aborted) abort();
              },
              async pull(controller) {
                try {
                  const next = await iterator.next();
                  if (next.done) {
                    closed = true;
                    controller.close();
                    await release();
                    return;
                  }
                  controller.enqueue(encoder.encode(next.value));
                } catch (error) {
                  succeeded = false;
                  logError("[openai] Stream failed", error);
                  if (!closed) {
                    closed = true;
                    controller.enqueue(
                      encoder.encode(
                        `data: ${JSON.stringify(buildOpenAIError(timeout.signal.aborted ? 504 : 500, "Agent execution failed", "server_error").body)}\n\n`,
                      ),
                    );
                    controller.close();
                  }
                  await release();
                }
              },
              async cancel() {
                closed = true;
                succeeded = false;
                clientCancel.abort();
                await release();
              },
            },
            { highWaterMark: 64 * 1024, size: (chunk) => chunk?.byteLength ?? 0 },
          );
          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "X-Accel-Buffering": "no",
              "X-Instance-Id": opened.instanceId,
              "X-Session-Id": lease.handle,
              "X-Session-Expires-At": new Date(lease.expiresAt).toISOString(),
              "X-Request-Id": String(set.headers["X-Request-Id"]),
            },
          });
        }
        const events = [];
        let bytes = 0;
        for await (const event of iterateWithSignal(turn.events(), signal)) {
          bytes += JSON.stringify(event).length;
          if (bytes > 16 * 1024 * 1024) throw new AppError("Agent response too large", "RESPONSE_TOO_LARGE", 500);
          events.push(event);
          if (classifyAgentTurnEvent(event)) break;
        }
        const response = mapToNonStreamingResponse(events, body.model);
        succeeded = true;
        await release();
        return response;
      } catch (error) {
        await release();
        if (timeout.signal.aborted) throw new AppError("Agent execution timeout", "AGENT_TIMEOUT", 504);
        throw error;
      }
    },
    {
      sessionAuth: true,
      headers: OpenAIChatHeadersSchema,
      body: OpenAIChatCompletionRequestSchema,
      response: {
        200: OpenAIChatCompletionResponseSchema,
        400: OpenAIErrorResponseSchema,
        401: OpenAIErrorResponseSchema,
        404: OpenAIErrorResponseSchema,
        409: OpenAIErrorResponseSchema,
        413: OpenAIErrorResponseSchema,
        422: OpenAIErrorResponseSchema,
        429: OpenAIErrorResponseSchema,
        500: OpenAIErrorResponseSchema,
        503: OpenAIErrorResponseSchema,
        504: OpenAIErrorResponseSchema,
      },
      detail: {
        tags: ["OpenAI Compatible"],
        summary: "Agent Chat Completions",
        description: "model 为 Agent 配置 ID。支持有序纯文本历史、JSON 与 SSE；只接收 model/messages/stream/n=1。",
        responses: {
          200: {
            description: "Native OpenAI JSON or SSE",
            content: {
              "text/event-stream": { schema: { type: "string" as const } },
            },
          },
        },
      },
    },
  );
}
