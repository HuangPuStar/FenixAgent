import { describe, expect, test } from "bun:test";
import { ProtocolAdapter } from "../client/protocol-adapter";

interface SentEvent {
  type: string;
  payload?: unknown;
}

function createAdapter(): { adapter: ProtocolAdapter; sent: SentEvent[] } {
  const sent: SentEvent[] = [];
  return {
    adapter: new ProtocolAdapter((update) =>
      sent.push({
        type: update.sessionUpdate,
        payload: update.content ?? ("entries" in update ? { entries: update.entries } : undefined),
      }),
    ),
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

  // 工具 JSON 增量不具备完整语义，不得伪装成文本或发布半成品计划。
  test("忽略流式工具输入增量", () => {
    const { adapter, sent } = createAdapter();

    adapter.handleSdkOutput({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"path":"' } },
    });

    expect(sent).toEqual([]);
  });

  // 工具起始帧没有完整 input，必须等待完整 assistant 块以避免创建重复调用。
  test("工具调用起始事件不发布半成品调用", () => {
    const { adapter, sent } = createAdapter();

    adapter.handleSdkOutput({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", id: "tool-1", name: "Bash" } },
    });

    expect(sent).toEqual([]);
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

  // 流式文本已发送后，完整 assistant 只补齐未发送后缀，普通工具仅发布一次。
  test("流式文本与 assistant 汇总按块补齐", () => {
    const { adapter, sent } = createAdapter();

    adapter.handleSdkOutput({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "流式" } },
    });
    adapter.handleSdkOutput({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "流式补齐" },
          { type: "tool_use", id: "tool-2", name: "Read", input: {} },
        ],
      },
    });

    expect(sent).toEqual([
      { type: "agent_message_chunk", payload: { type: "text", text: "流式" } },
      { type: "agent_message_chunk", payload: { type: "text", text: "补齐" } },
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

  // TodoWrite 必须发布标准 ACP plan 完整快照，且不得作为普通工具双重展示。
  test("将 TodoWrite 转换为标准 plan 快照", () => {
    const { adapter, sent } = createAdapter();

    adapter.handleSdkOutput({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "todo-1",
            name: "TodoWrite",
            input: {
              todos: [
                { content: "检查", status: "pending", activeForm: "正在检查" },
                { content: "修复", status: "in_progress" },
                { content: "验证", status: "completed" },
              ],
            },
          },
        ],
      },
    });

    expect(sent).toEqual([
      {
        type: "plan",
        payload: {
          entries: [
            { content: "检查", priority: "medium", status: "pending" },
            { content: "修复", priority: "medium", status: "in_progress" },
            { content: "验证", priority: "medium", status: "completed" },
          ],
        },
      },
    ]);
  });

  // 空 TodoWrite 是清理计划的有效完整快照，不能被 truthy 判断吞掉。
  test("TodoWrite 空数组清空 plan", () => {
    const { adapter, sent } = createAdapter();

    adapter.handleSdkOutput({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "todo-empty", name: "TodoWrite", input: { todos: [] } }] },
    });

    expect(sent).toEqual([{ type: "plan", payload: { entries: [] } }]);
  });

  // 非法 TodoWrite 不得损坏现有计划，诊断信息也不能包含原始用户内容。
  test("拒绝非法 TodoWrite 快照并保留脱敏诊断", () => {
    const sent: SentEvent[] = [];
    const diagnostics: string[] = [];
    const adapter = new ProtocolAdapter(
      (update) => sent.push({ type: update.sessionUpdate, payload: update.content }),
      (message) => diagnostics.push(message),
    );

    adapter.handleSdkOutput({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "敏感内容", status: "invalid" }] } },
        ],
      },
    });

    expect(sent).toEqual([]);
    expect(diagnostics).toEqual(["TodoWrite input is not a valid complete plan snapshot"]);
    expect(diagnostics[0]).not.toContain("敏感内容");
  });

  // 仅 thinking 走流式通道时，完整 assistant 的正文仍必须正常发送。
  test("thinking 与 text 按块独立去重", () => {
    const { adapter, sent } = createAdapter();

    adapter.handleSdkOutput({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "推理" } },
    });
    adapter.handleSdkOutput({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "推理" },
          { type: "text", text: "答案" },
        ],
      },
    });

    expect(sent).toEqual([
      { type: "agent_thought_chunk", payload: { type: "text", text: "推理" } },
      { type: "agent_message_chunk", payload: { type: "text", text: "答案" } },
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
