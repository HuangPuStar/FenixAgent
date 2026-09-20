import { log, error as logError } from "@fenix/logger";
import Elysia from "elysia";
import * as z from "zod/v4";
import { OpenAIChatCompletionRequestSchema, OpenAIErrorResponseSchema } from "../../schemas/openai-chat.schema";
import { openAgentSession } from "../../services/agent-chat-service";
import { buildOpenAIError, mapToNonStreamingResponse, mapToSSEChunks } from "../../services/openai-response-mapper";
import type { AuthContext } from "../../types/auth";
import type { AgentRuntimeAuthDependencies } from "../dependencies";

const AGENT_TIMEOUT_MS = 300_000; // 5 分钟

/**
 * 路由**内部**协作者的测试接缝（`openAgentSession` 是本包服务，宿主不该注入它）。
 *
 * 与工厂参数 `deps` 是两件事：工厂参数是宿主注入的认证守卫，这里是包内被测协作者的可替换点。
 * 保留既有 `setOpenAIChatRouteDeps` 名字与语义，避免为统一注入机制而扩大本任务范围。
 */
const sessionDeps = {
  openAgentSession,
};

/** 测试用：覆盖 route 内部依赖，避免 mock.module。 */
export function setOpenAIChatRouteDeps(overrides: Partial<typeof sessionDeps> | null): void {
  if (overrides) {
    Object.assign(sessionDeps, overrides);
    return;
  }
  sessionDeps.openAgentSession = openAgentSession;
}

const OpenAIChatParamsSchema = z
  .object({
    agentId: z.string().min(1).describe("平台 Agent 配置 ID。"),
  })
  .describe("OpenAI Chat 路径参数。");

/**
 * `/api/agents/:agentId/v1/chat/completions` 路由工厂。
 *
 * 会话守卫由宿主注入（CE 阶段 2 任务 1.4 W2）：`sessionAuth` 宏与 `store.user` / `store.authContext`
 * 必须与宿主 `/web/*` 路由是同一份实例——Elysia 的 macro / state 是实例作用域的，包内自建一份会让
 * 同一个进程出现两套互不可见的认证状态。
 */
export function createOpenaiChatRoutes(deps: AgentRuntimeAuthDependencies) {
  const app = new Elysia({ name: "openai-chat", prefix: "/api" }).use(deps.authGuardPlugin).model({
    "openai-chat-params": OpenAIChatParamsSchema,
  });

  app.post(
    "/agents/:agentId/v1/chat/completions",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia handler 参数类型推断受限
    async ({ params, body, request, store, error }: any) => {
      const authCtx = store.authContext as AuthContext;
      const agentConfigId = params.agentId as string;

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
      log(
        `[openai] Request: agentConfigId=${agentConfigId} stream=${isStream} hasSessionId=${sessionId !== undefined}`,
      );

      // 连接 Agent，创建 PromptTurn。
      // 错误统一交由全局 errorPlugin 按稳定错误码映射（404/409/422/503/429），本地
      // 不再嗅探 message 子串或拼接原文（A-P1.1 收敛）——编排域错误 message 可能
      // 携带 envId/machineId（如 ConcurrencyExceededError 拼接环境 ID），直出会泄漏
      // 内部资源标识；AppError/OrchestrationError 携带稳定 code，errorPlugin 可精确分类。
      const result = await sessionDeps.openAgentSession({
        userId: authCtx.userId,
        agentConfigId,
        organizationId: authCtx.organizationId,
        sessionId,
        startSource: "interactive",
      });
      const turn = result.turn;
      const instanceId = result.instanceId;
      log(`[openai] Agent session opened: instanceId=${instanceId}`);

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
              for await (const chunk of mapToSSEChunks(turn.events(), agentConfigId, abortController.signal)) {
                controller.enqueue(encoder.encode(chunk));
              }
            } catch (e) {
              // 流已开始后无法走 errorPlugin：错误 chunk 只输出通用文案（原始
              // message 可能携带 envId/machineId 等内部标识，直出会泄漏），
              // 完整诊断保留在服务端日志。
              logError("[openai] Stream failed:", e);
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ error: { message: "Agent execution failed", type: "server_error" } })}\n\n`,
                ),
              );
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
      }

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
              if (
                rpc?.jsonrpc === "2.0" &&
                (rpc as unknown as { result?: { stopReason?: unknown } }).result?.stopReason
              )
                break;
            }
          })(),
          timeoutPromise,
        ]);

        const response = mapToNonStreamingResponse(events, agentConfigId);
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
        // 其余错误（含 turn.prompt 同步抛错）交由全局 errorPlugin 兜底映射，
        // 不再本地拼接 500 原文（可能泄漏内部标识）。
        throw err;
      } finally {
        clearTimeout(timeoutId);
        await turn.dispose();
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
        409: OpenAIErrorResponseSchema,
        422: OpenAIErrorResponseSchema,
        500: OpenAIErrorResponseSchema,
        503: OpenAIErrorResponseSchema,
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

  return app;
}
