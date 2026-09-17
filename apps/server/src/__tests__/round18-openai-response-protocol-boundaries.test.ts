import { describe, expect, test } from "bun:test";
import {
  buildOpenAIError,
  mapToNonStreamingResponse,
  mapToSSEChunks,
  type RelayEvent,
} from "../services/openai-response-mapper";

function update(update: Record<string, unknown>): RelayEvent {
  return {
    type: "session_data",
    payload: { jsonrpc: "2.0", method: "session/update", params: { update } },
  };
}

function completion(reason: string): RelayEvent {
  return { type: "session_data", payload: { jsonrpc: "2.0", result: { stopReason: reason } } };
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

async function* events(values: RelayEvent[]): AsyncGenerator<RelayEvent, void, undefined> {
  for (const value of values) yield value;
}

function parseChunk(value: string): Record<string, unknown> {
  return JSON.parse(value.slice("data: ".length)) as Record<string, unknown>;
}

describe("openai response mapper protocol boundaries", () => {
  // 原始 JSON-RPC 格式必须被接受，兼容 relay 直通服务端事件。
  test("maps a raw JSON-RPC content update", () => {
    const result = mapToNonStreamingResponse(
      [
        {
          type: "ignored",
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "raw" } } },
        } as RelayEvent,
      ],
      "agent-1",
    );

    expect(result.choices[0].message.content).toBe("raw");
  });

  // 非 JSON-RPC 事件不能污染模型输出。
  test("ignores events without a JSON-RPC envelope", () => {
    const result = mapToNonStreamingResponse([{ type: "status", payload: { status: "ready" } }], "agent-1");

    expect(result.choices[0].message.content).toBe("");
    expect(result.choices[0].finish_reason).toBe("end_turn");
  });

  // 非 session/update 的 RPC 方法不是文本事件，必须忽略。
  test("ignores unrelated JSON-RPC methods", () => {
    const result = mapToNonStreamingResponse(
      [{ type: "session_data", payload: { jsonrpc: "2.0", method: "session/list", params: { update: {} } } }],
      "agent-1",
    );

    expect(result.choices[0].message.content).toBe("");
  });

  // 缺少 update 对象时不得抛出或生成空 chunk。
  test("ignores session updates without an update payload", () => {
    const result = mapToNonStreamingResponse(
      [{ type: "session_data", payload: { jsonrpc: "2.0", method: "session/update", params: {} } }],
      "agent-1",
    );

    expect(result.choices[0].message.content).toBe("");
  });

  // 未知 sessionUpdate 只作为 reasoning 分类且空文本不应进入响应。
  test("ignores unknown updates without renderable text", () => {
    const result = mapToNonStreamingResponse([update({ sessionUpdate: "future_event" })], "agent-1");

    expect(result.choices[0].message.reasoning_content).toBeUndefined();
  });

  // 没有 content 的文本更新不应生成字符串 "undefined"。
  test("ignores text updates that have no text content", () => {
    const result = mapToNonStreamingResponse([update({ sessionUpdate: "agent_message_chunk" })], "agent-1");

    expect(result.choices[0].message.content).toBe("");
  });

  // 未命名工具调用仍需保持协议可解析的默认名称。
  test("uses an unknown name for unnamed tool calls", () => {
    const result = mapToNonStreamingResponse([update({ sessionUpdate: "tool_call" })], "agent-1");

    expect(result.choices[0].message.content).toBe('<tool_call name="unknown" />\n');
  });

  // 未命名工具结果同样应保留稳定的默认名称。
  test("uses an unknown name for unnamed tool updates", () => {
    const result = mapToNonStreamingResponse([update({ sessionUpdate: "tool_call_update" })], "agent-1");

    expect(result.choices[0].message.content).toBe('<tool_result name="unknown" />\n');
  });

  // 计划条目应保留默认状态，避免前端把缺失状态理解为完成。
  test("renders plan entries with a pending default status", () => {
    const result = mapToNonStreamingResponse(
      [update({ sessionUpdate: "plan", entries: [{ content: "review" }] })],
      "agent-1",
    );

    expect(result.choices[0].message.reasoning_content).toBe("- [pending] review\n");
  });

  // 完成原因从尾部逆向获取，后续原因优先代表最终回合状态。
  test("uses the last available completion reason", () => {
    const result = mapToNonStreamingResponse([completion("tool_use"), completion("max_tokens")], "agent-1");

    expect(result.choices[0].finish_reason).toBe("max_tokens");
  });

  // SSE 文本块应位于 content delta，不能误写到 reasoning_content。
  test("streams content updates as content deltas", async () => {
    const chunks = await collect(
      mapToSSEChunks(
        events([update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } })]),
        "agent-1",
      ),
    );
    const payload = parseChunk(chunks[0]);

    expect((payload.choices as Array<{ delta: Record<string, string> }>)[0].delta).toEqual({ content: "answer" });
  });

  // SSE 思考块应位于 reasoning_content，保证 OpenAI 兼容客户端可区分展示。
  test("streams thought updates as reasoning deltas", async () => {
    const chunks = await collect(
      mapToSSEChunks(
        events([update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think" } })]),
        "agent-1",
      ),
    );
    const payload = parseChunk(chunks[0]);

    expect((payload.choices as Array<{ delta: Record<string, string> }>)[0].delta).toEqual({
      reasoning_content: "think",
    });
  });

  // 收到 stopReason 后必须发送结束块和 [DONE]，并调用生命周期回调。
  test("streams completion then done and reports the stop reason", async () => {
    const reasons: string[] = [];
    const chunks = await collect(
      mapToSSEChunks(events([completion("end_turn")]), "agent-1", undefined, (reason) => reasons.push(reason)),
    );
    const payload = parseChunk(chunks[0]);

    expect((payload.choices as Array<{ finish_reason: string }>)[0].finish_reason).toBe("end_turn");
    expect(chunks).toEqual([chunks[0], "data: [DONE]\n\n"]);
    expect(reasons).toEqual(["end_turn"]);
  });

  // stopReason 后的事件不得继续写出，避免已结束会话产生重复消息。
  test("does not stream updates after completion", async () => {
    const chunks = await collect(
      mapToSSEChunks(
        events([
          completion("end_turn"),
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } }),
        ]),
        "agent-1",
      ),
    );

    expect(chunks).toHaveLength(2);
    expect(chunks.join("")).not.toContain("late");
  });

  // 正常迭代结束时补充 end_turn，确保客户端资源能够释放。
  test("adds a fallback completion when the event source ends", async () => {
    const chunks = await collect(mapToSSEChunks(events([]), "agent-1"));
    const payload = parseChunk(chunks[0]);

    expect((payload.choices as Array<{ finish_reason: string }>)[0].finish_reason).toBe("end_turn");
    expect(chunks[1]).toBe("data: [DONE]\n\n");
  });

  // 取消信号应停止消费后续 relay 消息，并走兜底结束帧释放客户端。
  test("stops on an aborted signal and emits fallback completion", async () => {
    const controller = new AbortController();
    controller.abort();
    const chunks = await collect(
      mapToSSEChunks(
        events([update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hidden" } })]),
        "agent-1",
        controller.signal,
      ),
    );

    expect(chunks.join("")).not.toContain("hidden");
    expect(chunks).toHaveLength(2);
  });

  // 空文本更新不应产生数据帧，只保留流结束所需的两个帧。
  test("does not emit a data chunk for an empty text update", async () => {
    const chunks = await collect(mapToSSEChunks(events([update({ sessionUpdate: "agent_message_chunk" })]), "agent-1"));

    expect(chunks).toHaveLength(2);
  });

  // 流式事件必须在整个响应中复用同一个 chat completion ID。
  test("reuses one response id across streamed chunks", async () => {
    const chunks = await collect(
      mapToSSEChunks(
        events([
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one" } }),
          completion("end_turn"),
        ]),
        "agent-1",
      ),
    );
    const first = parseChunk(chunks[0]);
    const second = parseChunk(chunks[1]);

    expect(first.id).toBe(second.id);
  });

  // 401 错误遵循 OpenAI invalid_api_key 契约。
  test("maps unauthorized errors to invalid_api_key", () => {
    expect(buildOpenAIError(401, "denied", "authentication_error")).toEqual({
      status: 401,
      body: { error: { message: "denied", type: "authentication_error", code: "invalid_api_key" } },
    });
  });

  // 非认证错误不得伪装成无效 API Key。
  test("omits an API key code for non-authentication errors", () => {
    expect(buildOpenAIError(429, "slow down", "rate_limit_error")).toEqual({
      status: 429,
      body: { error: { message: "slow down", type: "rate_limit_error", code: undefined } },
    });
  });
});
