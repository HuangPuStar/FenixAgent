import type { OpenAIChatCompletionResponse } from "../schemas/openai-chat.schema";

// ── ACP 事件类型 ──

/** 从 relay handle 接收的原始消息 */
export interface RelayEvent {
  type: string;
  payload?: unknown;
}

/** session/update 的内部结构 */
export interface SessionUpdateEvent {
  sessionUpdate: string;
  messageId?: string;
  content?: { type: string; text: string };
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  entries?: Array<{ content: string; priority?: string; status?: string }>;
  used?: number;
  size?: number;
}

// ── 统一 JSON-RPC 提取 ──

/**
 * 从 relay 事件中提取 JSON-RPC 对象。
 * 兼容两种格式：
 *   server.ts 路径：raw { jsonrpc, method, params } (event 本身)
 *   session-manager 路径：{ type: "session_data", payload: rawJsonRpc }
 */
function extractJsonRpc(ev: RelayEvent): Record<string, unknown> | null {
  if ((ev as unknown as Record<string, unknown>).jsonrpc === "2.0") return ev as unknown as Record<string, unknown>;
  const payload = ev.payload as Record<string, unknown> | undefined;
  if (payload?.jsonrpc === "2.0") return payload;
  return null;
}

// ── 消息分类 ──

type ChunkKind = "reasoning" | "content";

function classifyUpdate(update: SessionUpdateEvent): ChunkKind {
  switch (update.sessionUpdate) {
    case "agent_thought_chunk":
    case "plan":
      return "reasoning";
    case "agent_message_chunk":
    case "tool_call":
    case "tool_call_update":
      return "content";
    default:
      return "reasoning"; // 未知类型默认归入 reasoning
  }
}

function formatUpdateText(update: SessionUpdateEvent): string {
  switch (update.sessionUpdate) {
    case "agent_thought_chunk":
    case "agent_message_chunk":
      return update.content?.text ?? "";
    case "tool_call":
      return `<tool_call name="${update.title ?? "unknown"}" />\n`;
    case "tool_call_update":
      return `<tool_result name="${update.title ?? "unknown"}" />\n`;
    case "plan":
      return `${(update.entries ?? []).map((e) => `- [${e.status ?? "pending"}] ${e.content}`).join("\n")}\n`;
    default:
      return "";
  }
}

// ── 从 relay 事件流中提取 SessionUpdateEvent ──

function extractUpdateFromRelayEvent(ev: RelayEvent): SessionUpdateEvent | null {
  const rpc = extractJsonRpc(ev);
  if (!rpc) return null;
  if (rpc.method !== "session/update" || !(rpc.params as Record<string, unknown>)?.update) return null;
  return (rpc.params as Record<string, unknown>).update as SessionUpdateEvent;
}

function extractCompletionFromRelayEvent(ev: RelayEvent): string | null {
  const rpc = extractJsonRpc(ev);
  if (!rpc) return null;
  const result = rpc.result as Record<string, unknown> | undefined;
  if (result?.stopReason) return result.stopReason as string;
  return null;
}

// ── 消息收集器 ──

interface CollectedMessages {
  reasoningParts: string[];
  contentParts: string[];
}

/** 遍历 relay 事件，按分类收集文本 */
function collectMessages(events: RelayEvent[]): CollectedMessages {
  const result: CollectedMessages = { reasoningParts: [], contentParts: [] };

  for (const ev of events) {
    const update = extractUpdateFromRelayEvent(ev);
    if (!update) continue;

    const kind = classifyUpdate(update);
    const text = formatUpdateText(update);
    if (!text) continue;

    if (kind === "reasoning") {
      result.reasoningParts.push(text);
    } else {
      result.contentParts.push(text);
    }
  }

  return result;
}

/** 从事件流末尾找到 stopReason */
function findStopReason(events: RelayEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const reason = extractCompletionFromRelayEvent(events[i]);
    if (reason) return reason;
  }
  return "end_turn";
}

// ── 公开 API ──

/** 生成唯一响应 ID */
function generateChatId(): string {
  return `chatcmpl-${crypto.randomUUID()}`;
}

/**
 * 将 relay 事件流映射为非流式 OpenAI Chat Completion 响应。
 */
export function mapToNonStreamingResponse(events: RelayEvent[], agentId: string): OpenAIChatCompletionResponse {
  const collected = collectMessages(events);
  const stopReason = findStopReason(events);
  const reasoningContent = collected.reasoningParts.join("");
  const content = collected.contentParts.join("");

  return {
    id: generateChatId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: agentId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        },
        finish_reason: stopReason,
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * 将 relay 事件流映射为 SSE chunk 的异步生成器。
 * @param eventsIterable 异步 relay 事件流
 * @param agentId Agent ID
 * @param signal 用于检测客户端断开
 * @param onStopReason 当收到 stopReason 时的回调（用于设置 finish_reason）
 */
export async function* mapToSSEChunks(
  eventsIterable: AsyncIterable<RelayEvent>,
  agentId: string,
  signal?: AbortSignal,
  onStopReason?: (reason: string) => void,
): AsyncGenerator<string, void, undefined> {
  const chatId = generateChatId();
  const created = Math.floor(Date.now() / 1000);
  let finished = false;

  for await (const ev of eventsIterable) {
    if (signal?.aborted) break;
    if (finished) break;

    // 检测会话结束
    const stopReason = extractCompletionFromRelayEvent(ev);
    if (stopReason) {
      onStopReason?.(stopReason);
      yield `data: ${JSON.stringify({
        id: chatId,
        object: "chat.completion.chunk",
        created,
        model: agentId,
        choices: [{ index: 0, delta: {}, finish_reason: stopReason }],
      })}\n\n`;
      yield "data: [DONE]\n\n";
      finished = true;
      break;
    }

    const update = extractUpdateFromRelayEvent(ev);
    if (!update) continue;

    const kind = classifyUpdate(update);
    const text = formatUpdateText(update);
    if (!text) continue;

    const delta: Record<string, string> = {};
    if (kind === "reasoning") {
      delta.reasoning_content = text;
    } else {
      delta.content = text;
    }

    yield `data: ${JSON.stringify({
      id: chatId,
      object: "chat.completion.chunk",
      created,
      model: agentId,
      choices: [{ index: 0, delta }],
    })}\n\n`;
  }

  // 兜底：如果流结束但没发 stopReason
  if (!finished) {
    yield `data: ${JSON.stringify({
      id: chatId,
      object: "chat.completion.chunk",
      created,
      model: agentId,
      choices: [{ index: 0, delta: {}, finish_reason: "end_turn" }],
    })}\n\n`;
    yield "data: [DONE]\n\n";
  }
}

/** 构建 OpenAI 兼容错误数据 */
export function buildOpenAIError(status: number, message: string, type: string) {
  return {
    status,
    body: {
      error: { message, type, code: status === 401 ? "invalid_api_key" : undefined },
    },
  };
}
