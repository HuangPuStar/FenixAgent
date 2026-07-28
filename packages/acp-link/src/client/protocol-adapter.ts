// biome-ignore lint/suspicious/noExplicitAny: SDKMessage types vary by message kind
type SDKMessage = Record<string, any>;

/**
 * ACP ↔ stream-json 双向协议转换核心。
 * Claude Code CLI 使用 stream-json 协议（而非 ACP NDJSON），
 * ProtocolAdapter 负责将 ACP 消息转换为 SDK 输入，并将 SDK 输出转换为 ACP 事件。
 */
export class ProtocolAdapter {
  private abortController: AbortController | null = null;

  /** 跟踪当前回合是否已经通过 stream_event 流式推送过文本内容 */
  private streamedTextThisTurn = false;

  constructor(private send: (type: string, payload?: unknown) => void) {}

  /** 处理来自 relay 的 ACP 消息，转换为 SDK 操作 */
  async handleAcpMessage(acpMessage: Record<string, unknown>): Promise<void> {
    const type = acpMessage.type as string;
    const payload = (acpMessage.payload ?? {}) as Record<string, unknown>;

    switch (type) {
      case "new_session":
        this.send("session_created", { sessionId: "claude_session" });
        break;
      case "prompt": {
        const blocks = (payload.content as Array<{ type: string; text?: string }>) ?? [];
        const input = blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
        this.send("prompt_started", { input });
        break;
      }
      case "cancel":
        if (this.abortController) {
          this.abortController.abort();
          this.abortController = null;
        }
        this.send("prompt_complete", { stopReason: "cancelled" });
        break;
      case "list_sessions":
        this.send("session_list", { sessions: [] });
        break;
      default:
        break;
    }
  }

  /** 处理 SDK 流式输出，转换为 ACP 事件。SDK 结构性在 message.content 中。 */
  handleSdkOutput(message: SDKMessage): void {
    if (message.type === "stream_event") {
      // SDK 流式事件（includePartialMessages: true 时触发）
      // event 是 Anthropic API 原生的 BetaRawMessageStreamEvent
      const event = message.event as Record<string, unknown> | undefined;
      if (!event) return;
      console.log(
        "[protocol-debug] stream_event type:",
        event.type,
        "delta:",
        JSON.stringify((event.delta as Record<string, unknown> | undefined)?.type ?? "none").slice(0, 60),
      );
      switch (event.type) {
        case "content_block_delta": {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            this.streamedTextThisTurn = true;
            console.log("[protocol-debug] → agent_message_chunk:", (delta.text as string).slice(0, 50));
            this.send("agent_message_chunk", { type: "text", text: delta.text as string });
          } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
            this.streamedTextThisTurn = true;
            console.log("[protocol-debug] → agent_thought_chunk:", (delta.thinking as string).slice(0, 50));
            this.send("agent_thought_chunk", { type: "text", text: delta.thinking as string });
          } else if (delta?.type === "input_json_delta" && delta.partial_json) {
            // tool_use 参数流式增量，透传
            this.send("agent_message_chunk", { type: "tool_input_delta", partial: delta.partial_json });
          }
          break;
        }
        case "content_block_start": {
          const contentBlock = event.content_block as Record<string, unknown> | undefined;
          if (contentBlock?.type === "tool_use") {
            this.send("tool_call", { id: contentBlock.id, name: contentBlock.name, input: {} });
          }
          break;
        }
        case "message_start":
        case "message_delta":
        case "message_stop":
          // 消息边界事件，不需要转发给前端
          break;
      }
    } else if (message.type === "assistant") {
      // SDK 的 assistant 消息内容在 message.content 中
      // 如果已经通过 stream_event 流式推送过文本，跳过 text/thinking 块避免重复
      const sdkMsg = message as Record<string, unknown>;
      const inner = (sdkMsg.message ?? message) as Record<string, unknown>;
      const blocks = (inner.content ?? []) as Array<Record<string, unknown>>;
      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          if (!this.streamedTextThisTurn) {
            this.send("agent_message_chunk", { type: "text", text: block.text });
          }
        } else if (block.type === "thinking" && block.thinking) {
          if (!this.streamedTextThisTurn) {
            this.send("agent_thought_chunk", { type: "text", text: block.thinking });
          }
        } else if (block.type === "tool_use") {
          this.send("tool_call", block);
        }
      }
    } else if (message.type === "result") {
      this.streamedTextThisTurn = false;
      this.send("prompt_complete", { stopReason: message.subtype ?? message.stopReason ?? "end_turn" });
    } else if (message.type === "system") {
      const subtype = message.subtype as string | undefined;
      if (subtype === "init") {
        this.send("status", {
          connected: true,
          agentInfo: { name: "Claude Code", version: message.version ?? "unknown" },
          capabilities: {
            loadSession: false,
            promptCapabilities: { embeddedContext: true, image: true },
            sessionCapabilities: {},
          },
        });
      } else if (subtype === "thinking_tokens") {
        // 思考进度 → 前端显示 "思考中..."
        this.send("agent_thought_chunk", {
          type: "text",
          text: "",
          _meta: { thinkingTokens: (message as Record<string, unknown>).estimated_tokens },
        });
      } else {
        // 其他 system 消息透传（如 hooks 事件、权限状态变更等）
        this.send("status", {
          connected: true,
          _meta: { systemSubtype: subtype, systemMessage: message },
        });
      }
    } else if (message.type === "user") {
      // 用户消息回显（CC 可能会回放历史消息）
      // 作为 user_message_chunk 转发
      const blocks = (message as Record<string, unknown>).message
        ? ((message as Record<string, unknown>).message as Record<string, unknown>)?.content
        : undefined;
      if (Array.isArray(blocks as unknown)) {
        for (const block of blocks as Array<Record<string, unknown>>) {
          if (block.type === "text" && block.text) {
            this.send("user_message_chunk", { type: "text", text: block.text as string });
          }
        }
      }
    }
  }

  setAbortController(ac: AbortController): void {
    this.abortController = ac;
  }
}
