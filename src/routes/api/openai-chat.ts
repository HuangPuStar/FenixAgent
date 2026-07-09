import { log } from "@fenix/logger";
import Elysia from "elysia";
import * as z from "zod/v4";
import { type AuthContext, authGuardPlugin } from "../../plugins/auth";
import { OpenAIChatCompletionRequestSchema, OpenAIErrorResponseSchema } from "../../schemas/openai-chat.schema";
import { openAgentSession } from "../../services/agent-chat-service";
import { buildOpenAIError, mapToNonStreamingResponse, mapToSSEChunks } from "../../services/openai-response-mapper";

const AGENT_TIMEOUT_MS = 300_000; // 5 分钟

const OpenAIChatParamsSchema = z
  .object({
    agentId: z.string().min(1).describe("平台 Agent UUID"),
  })
  .describe("OpenAI Chat 路径参数。");

const app = new Elysia({ name: "openai-chat", prefix: "/v1" }).use(authGuardPlugin).model({
  "openai-chat-params": OpenAIChatParamsSchema,
});

app.post(
  "/agents/:agentId/v1/chat/completions",
  async ({ params, body, request, store, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const agentId = params.agentId as string;

    // 解析请求体（只取最后一条 user 消息）
    const req = body as Record<string, unknown>;
    const isStream = req.stream === true;
    const messages = (req.messages ?? []) as Array<{ role: string; content: string | null }>;
    const userMessages = messages.filter((m) => m.role === "user");
    if (userMessages.length === 0) {
      const errResp = buildOpenAIError(400, "No user message in messages array", "invalid_request_error");
      return error(errResp.status, errResp.body);
    }
    const lastUserMessage = userMessages[userMessages.length - 1];
    const userContent = typeof lastUserMessage.content === "string" ? lastUserMessage.content : "";

    // 读取 X-Session-Id header（会话恢复）
    const sessionId = (request.headers as Headers).get("x-session-id") ?? undefined;
    log(`[openai] Request: agentId=${agentId} stream=${isStream} sessionId=${sessionId ?? "none"}`);

    // 连接 Agent，创建 PromptTurn
    let turn: Awaited<ReturnType<typeof openAgentSession>>["turn"] | null = null;
    let instanceId: string | null = null;
    try {
      const result = await openAgentSession({
        userId: authCtx.userId,
        agentId,
        organizationId: authCtx.organizationId,
        sessionId,
      });
      turn = result.turn;
      instanceId = result.instanceId;
      log(`[openai] Agent session opened: instanceId=${instanceId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("Environment not found")) {
        const errResp = buildOpenAIError(404, `Agent ${agentId} not found`, "invalid_request_error");
        return error(errResp.status, errResp.body);
      }
      const errResp = buildOpenAIError(500, `Failed to start agent: ${msg}`, "server_error");
      return error(errResp.status, errResp.body);
    }

    try {
      // 发送 prompt
      turn.prompt([{ type: "text", text: userContent }]);

      if (isStream) {
        // ── 流式响应 ──
        const abortController = new AbortController();
        const streamTimeoutId = setTimeout(() => {
          abortController.abort();
        }, AGENT_TIMEOUT_MS);
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            try {
              for await (const chunk of mapToSSEChunks(turn.events(), agentId, abortController.signal)) {
                controller.enqueue(encoder.encode(chunk));
              }
            } catch (e) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: String(e) } })}\n\n`));
            } finally {
              clearTimeout(streamTimeoutId);
              controller.close();
              await turn.dispose().catch(() => {});
            }
          },
          cancel() {
            clearTimeout(streamTimeoutId);
            abortController.abort();
            turn.dispose().catch(() => {});
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
      } else {
        // ── 非流式响应 ──
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("Agent execution timeout")), AGENT_TIMEOUT_MS);
        });

        try {
          const events: Array<{ type: string; payload?: unknown }> = [];
          await Promise.race([
            (async () => {
              for await (const ev of turn.events()) {
                events.push(ev as unknown as { type: string; payload?: unknown });
                // 兼容两种格式检测完成信号
                const asRaw = ev as unknown as Record<string, unknown>;
                const rpc = asRaw.jsonrpc === "2.0" ? asRaw : (ev.payload as Record<string, unknown> | undefined);
                if (rpc?.jsonrpc === "2.0" && (rpc as any).result?.stopReason) break;
              }
            })(),
            timeoutPromise,
          ]);

          const response = mapToNonStreamingResponse(events as any, agentId);
          log(
            `[openai] Non-streaming response: finish_reason=${response.choices[0].finish_reason} events=${events.length}`,
          );
          return response;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === "Agent execution timeout") {
            const errResp = buildOpenAIError(504, "Agent execution timeout after 300s", "timeout");
            return error(errResp.status, errResp.body);
          }
          throw err;
        } finally {
          clearTimeout(timeoutId);
          await turn.dispose();
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errResp = buildOpenAIError(500, `Agent execution error: ${msg}`, "server_error");
      return error(errResp.status, errResp.body);
    }
  },
  {
    sessionAuth: true,
    params: "openai-chat-params",
    body: OpenAIChatCompletionRequestSchema,
    response: {
      400: OpenAIErrorResponseSchema,
      401: OpenAIErrorResponseSchema,
      404: OpenAIErrorResponseSchema,
      500: OpenAIErrorResponseSchema,
      504: OpenAIErrorResponseSchema,
    },
    detail: {
      tags: ["OpenAI Compatible"],
      summary: "OpenAI Chat Completions 兼容接口",
      description:
        "标准 OpenAI Chat Completions API 兼容端点。通过 URL 路径指定 Agent，" +
        "仅取 messages 最后一条 user 消息作为输入，支持 stream 和非 stream 两种模式。" +
        "中间思考过程通过 DeepSeek 兼容的 reasoning_content 返回。" +
        "通过 X-Session-Id header 可恢复已有 Agent 会话（传入 ACP session ID）。",
    },
  },
);

export default app;
