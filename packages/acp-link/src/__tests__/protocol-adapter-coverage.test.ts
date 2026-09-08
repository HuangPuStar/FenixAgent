import { describe, expect, test } from "bun:test";
import { ProtocolAdapter } from "../client/protocol-adapter";

interface SentEvent {
  type: string;
  payload?: unknown;
}

function createAdapter(): { adapter: ProtocolAdapter; sent: SentEvent[] } {
  const sent: SentEvent[] = [];
  return {
    adapter: new ProtocolAdapter((type, payload) => sent.push({ type, payload })),
    sent,
  };
}

describe("ProtocolAdapter Claude SDK 消息翻译", () => {
  // 新会话请求必须产生稳定会话创建事件，供上层进入可 prompt 状态
  test("翻译 new_session 为 session_created", async () => {
    const { adapter, sent } = createAdapter();

    await adapter.handleAcpMessage({ type: "new_session" });

    expect(sent).toEqual([{ type: "session_created", payload: { sessionId: "claude_session" } }]);
  });

  // 多文本块 prompt 应按原始顺序合并，非文本块不能污染提交给 SDK 的输入
  test("合并 prompt 中的文本块并忽略非文本块", async () => {
    const { adapter, sent } = createAdapter();

    await adapter.handleAcpMessage({
      type: "prompt",
      payload: { content: [{ type: "text", text: "第一段" }, { type: "image" }, { type: "text", text: "第二段" }] },
    });

    expect(sent).toEqual([{ type: "prompt_started", payload: { input: "第一段\n\n第二段" } }]);
  });

  // 缺少 prompt 内容时仍应开始空回合，避免协议层因可选字段缺失抛错
  test("缺少 prompt 内容时发送空输入", async () => {
    const { adapter, sent } = createAdapter();

    await adapter.handleAcpMessage({ type: "prompt", payload: {} });

    expect(sent).toEqual([{ type: "prompt_started", payload: { input: "" } }]);
  });

  // cancel 即使没有 AbortController 也必须回传取消终态，保证调用方能收敛 loading
  test("无活跃 AbortController 时 cancel 仍发送取消终态", async () => {
    const { adapter, sent } = createAdapter();

    await adapter.handleAcpMessage({ type: "cancel" });

    expect(sent).toEqual([{ type: "prompt_complete", payload: { stopReason: "cancelled" } }]);
  });

  // cancel 必须中断当前控制器并清空引用，重复取消不得再次中断旧回合
  test("cancel 只中断当前回合一次", async () => {
    const { adapter, sent } = createAdapter();
    const controller = new AbortController();
    adapter.setAbortController(controller);

    await adapter.handleAcpMessage({ type: "cancel" });
    await adapter.handleAcpMessage({ type: "cancel" });

    expect(controller.signal.aborted).toBe(true);
    expect(sent).toEqual([
      { type: "prompt_complete", payload: { stopReason: "cancelled" } },
      { type: "prompt_complete", payload: { stopReason: "cancelled" } },
    ]);
  });

  // list_sessions 是本地 adapter 的安全空实现，不能泄露或伪造历史会话
  test("翻译 list_sessions 为安全空列表", async () => {
    const { adapter, sent } = createAdapter();

    await adapter.handleAcpMessage({ type: "list_sessions" });

    expect(sent).toEqual([{ type: "session_list", payload: { sessions: [] } }]);
  });

  // 未识别的 ACP 请求应被静默忽略，避免协议扩展导致无关副作用
  test("忽略未知 ACP 请求", async () => {
    const { adapter, sent } = createAdapter();

    await adapter.handleAcpMessage({ type: "future_method", payload: { value: "ignored" } });

    expect(sent).toEqual([]);
  });

  // SDK 文本增量必须逐块翻译为 agent_message_chunk，保留原始文本
  test("翻译流式文本增量", () => {
    const { adapter, sent } = createAdapter();

    adapter.handleSdkOutput({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "你好" } },
    });

    expect(sent).toEqual([{ type: "agent_message_chunk", payload: { type: "text", text: "你好" } }]);
  });

  // SDK 思考增量必须使用独立事件，不能与用户可见文本混合
  test("翻译流式思考增量", () => {
    const { adapter, sent } = createAdapter();

    adapter.handleSdkOutput({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "分析中" } },
    });

    expect(sent).toEqual([{ type: "agent_thought_chunk", payload: { type: "text", text: "分析中" } }]);
  });

  // 工具 JSON 增量应保留 partial 内容，使前端可展示尚未完成的工具输入
  test("翻译流式工具输入增量", () => {
    const { adapter, sent } = createAdapter();

    adapter.handleSdkOutput({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"path":"' } },
    });

    expect(sent).toEqual([
      { type: "agent_message_chunk", payload: { type: "tool_input_delta", partial: '{"path":"' } },
    ]);
  });

  // tool_use 起始事件必须保留工具标识和名称，以便权限与结果回传关联同一次调用
  test("翻译工具调用起始事件", () => {
    const { adapter, sent } = createAdapter();

    adapter.handleSdkOutput({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", id: "tool-1", name: "Bash" } },
    });

    expect(sent).toEqual([{ type: "tool_call", payload: { id: "tool-1", name: "Bash", input: {} } }]);
  });

  // 不完整流事件和消息边界事件不得生成伪消息，保证流式错误隔离
  test("忽略不完整流事件与消息边界", () => {
    const { adapter, sent } = createAdapter();

    adapter.handleSdkOutput({ type: "stream_event" });
    adapter.handleSdkOutput({ type: "stream_event", event: { type: "message_start" } });
    adapter.handleSdkOutput({ type: "stream_event", event: { type: "message_delta" } });
    adapter.handleSdkOutput({ type: "stream_event", event: { type: "message_stop" } });

    expect(sent).toEqual([]);
  });

  // 流式文本已发送后，assistant 汇总文本必须跳过，避免同一消息在客户端重复渲染
  test("流式文本与 assistant 汇总之间保持去重隔离", () => {
    const { adapter, sent } = createAdapter();

    adapter.handleSdkOutput({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "流式" } },
    });
    adapter.handleSdkOutput({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "汇总" },
          { type: "tool_use", id: "tool-2", name: "Read", input: {} },
        ],
      },
    });

    expect(sent).toEqual([
      { type: "agent_message_chunk", payload: { type: "text", text: "流式" } },
      { type: "tool_call", payload: { type: "tool_use", id: "tool-2", name: "Read", input: {} } },
    ]);
  });

  // 未经过流式通道的 assistant 内容应完整翻译文本、思考和工具调用
  test("翻译非流式 assistant 的所有支持内容块", () => {
    const { adapter, sent } = createAdapter();

    adapter.handleSdkOutput({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "答复" },
          { type: "thinking", thinking: "推理" },
          { type: "tool_use", id: "tool-3", name: "Write", input: { path: "a" } },
        ],
      },
    });

    expect(sent).toEqual([
      { type: "agent_message_chunk", payload: { type: "text", text: "答复" } },
      { type: "agent_thought_chunk", payload: { type: "text", text: "推理" } },
      { type: "tool_call", payload: { type: "tool_use", id: "tool-3", name: "Write", input: { path: "a" } } },
    ]);
  });

  // result 的 subtype 优先于 stopReason，且必须重置去重状态供下一回合输出汇总文本
  test("result 发送终态并为下一回合重置流式去重", () => {
    const { adapter, sent } = createAdapter();

    adapter.handleSdkOutput({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "第一回合" } },
    });
    adapter.handleSdkOutput({ type: "result", subtype: "max_turns", stopReason: "end_turn" });
    adapter.handleSdkOutput({ type: "assistant", message: { content: [{ type: "text", text: "下一回合" }] } });

    expect(sent).toEqual([
      { type: "agent_message_chunk", payload: { type: "text", text: "第一回合" } },
      { type: "prompt_complete", payload: { stopReason: "max_turns" } },
      { type: "agent_message_chunk", payload: { type: "text", text: "下一回合" } },
    ]);
  });

  // result 必须把 SDK snake_case usage 转成 ACP camelCase usage；缓存命中同样占用上下文窗口。
  test("result 转发完整 token 用量", () => {
    const { adapter, sent } = createAdapter();

    adapter.handleSdkOutput({
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 50,
      },
    });

    expect(sent).toEqual([
      {
        type: "prompt_complete",
        payload: {
          stopReason: "success",
          usage: { totalTokens: 200, inputTokens: 180, outputTokens: 20 },
        },
      },
    ]);
  });

  // init status 必须声明前端协商所需能力与 SDK 版本
  test("翻译 init 为带 capability 的连接状态", () => {
    const { adapter, sent } = createAdapter();

    adapter.handleSdkOutput({ type: "system", subtype: "init", version: "1.2.3" });

    expect(sent).toEqual([
      {
        type: "status",
        payload: {
          connected: true,
          agentInfo: { name: "Claude Code", version: "1.2.3" },
          capabilities: {
            loadSession: false,
            promptCapabilities: { embeddedContext: true, image: true },
            sessionCapabilities: {},
          },
        },
      },
    ]);
  });

  // thinking_tokens 应转为无文本思考进度，避免向用户暴露内部计数格式
  test("翻译 thinking_tokens 为思考进度元数据", () => {
    const { adapter, sent } = createAdapter();

    adapter.handleSdkOutput({ type: "system", subtype: "thinking_tokens", estimated_tokens: 42 });

    expect(sent).toEqual([
      { type: "agent_thought_chunk", payload: { type: "text", text: "", _meta: { thinkingTokens: 42 } } },
    ]);
  });

  // 未知 system 消息必须保留 subtype 与原始消息，便于诊断 SDK 协议演进
  test("透传未知 system 消息的诊断元数据", () => {
    const { adapter, sent } = createAdapter();
    const message = { type: "system", subtype: "hook_event", hook: "after_tool" };

    adapter.handleSdkOutput(message);

    expect(sent).toEqual([
      { type: "status", payload: { connected: true, _meta: { systemSubtype: "hook_event", systemMessage: message } } },
    ]);
  });

  // 用户回放只转发文本块，并忽略图片或空文本，避免历史回放污染消息流
  test("翻译用户消息并隔离非文本内容", () => {
    const { adapter, sent } = createAdapter();

    adapter.handleSdkOutput({
      type: "user",
      message: { content: [{ type: "text", text: "用户问题" }, { type: "image" }, { type: "text", text: "" }] },
    });

    expect(sent).toEqual([{ type: "user_message_chunk", payload: { type: "text", text: "用户问题" } }]);
  });
});
